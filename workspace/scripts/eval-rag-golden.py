from __future__ import annotations

import argparse
import concurrent.futures
import json
import math
import os
import statistics
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "content" / "eval" / "rag-natural-golden.jsonl"


def read_env(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.exists():
        return out
    for raw in path.read_text(encoding="utf-8-sig").splitlines():
        line = raw.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            out[key.strip()] = value.split(" #", 1)[0].strip()
    return out


def quantile(values: list[float], q: float) -> float:
    if not values:
        return 0.0
    xs = sorted(values)
    pos = (len(xs) - 1) * q
    low = math.floor(pos)
    high = math.ceil(pos)
    if low == high:
        return xs[low]
    return xs[low] * (high - pos) + xs[high] * (pos - low)


def main() -> None:
    # Windows mặc định cp1252: in miss tiếng Việt sẽ UnicodeEncodeError sau khi đã chạy xong cả eval.
    sys.stdout.reconfigure(encoding="utf-8")
    parser = argparse.ArgumentParser(description="Evaluate the frozen natural-query RAG golden set")
    parser.add_argument("--split", choices=["dev", "holdout", "all"], default="dev")
    parser.add_argument("--url", default="http://127.0.0.1:3010/v1/retrieval/search")
    parser.add_argument("--k", type=int, default=5)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--json-out")
    args = parser.parse_args()

    env = {**read_env(ROOT / ".env"), **os.environ}
    token = env.get("INTERNAL_SERVICE_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"

    rows = [json.loads(line) for line in DATASET.read_text(encoding="utf-8").splitlines() if line.strip()]
    if args.split != "all":
        rows = [row for row in rows if row["split"] == args.split]

    def run(row: dict) -> dict:
        started = time.perf_counter()
        try:
            response = requests.post(
                args.url,
                headers=headers,
                json={"query": row["query"], "k": args.k, "queryLang": row["language"]},
                timeout=args.timeout,
            )
            elapsed = (time.perf_counter() - started) * 1000
            body = response.json() if response.headers.get("content-type", "").startswith("application/json") else None
            hits = body if response.status_code == 200 and isinstance(body, list) else []
            slugs = [str(hit.get("docSlug") or "") for hit in hits]
            expected = list(row["expected_document_ids"])
            return {
                **row,
                "status": response.status_code,
                "latency_ms": elapsed,
                "hit_slugs": slugs,
                "top1_ok": bool(expected and slugs and slugs[0] in expected),
                "recall5_ok": bool(expected and any(doc in slugs[:5] for doc in expected)),
                "predicted_no_answer": not slugs,
                "error": None if response.status_code == 200 else str(body)[:500],
            }
        except Exception as exc:
            return {
                **row,
                "status": None,
                "latency_ms": (time.perf_counter() - started) * 1000,
                "hit_slugs": [],
                "top1_ok": False,
                "recall5_ok": False,
                "predicted_no_answer": True,
                "error": f"{type(exc).__name__}: {exc}",
            }

    started = time.perf_counter()
    with concurrent.futures.ThreadPoolExecutor(max_workers=max(1, args.workers)) as pool:
        results = list(pool.map(run, rows))
    wall = time.perf_counter() - started

    answerable = [row for row in results if row["expected_document_ids"]]
    no_answer = [row for row in results if not row["expected_document_ids"]]
    predicted_no_answer = [row for row in results if row["predicted_no_answer"]]
    true_no_answer_predicted = [row for row in no_answer if row["predicted_no_answer"]]
    errors = [row for row in results if row["status"] != 200]
    latencies = [float(row["latency_ms"]) for row in results]

    metrics = {
        "split": args.split,
        "cases": len(results),
        "answerable_cases": len(answerable),
        "no_answer_cases": len(no_answer),
        "top1_accuracy": sum(row["top1_ok"] for row in answerable) / len(answerable) if answerable else 0.0,
        "recall_at_5": sum(row["recall5_ok"] for row in answerable) / len(answerable) if answerable else 0.0,
        "no_answer_precision": (
            len(true_no_answer_predicted) / len(predicted_no_answer) if predicted_no_answer else 0.0
        ),
        "no_answer_recall": len(true_no_answer_predicted) / len(no_answer) if no_answer else 0.0,
        "false_positive_retrieval_on_no_answer": (
            sum(not row["predicted_no_answer"] for row in no_answer) / len(no_answer) if no_answer else 0.0
        ),
        "http_error_rate": len(errors) / len(results) if results else 0.0,
        "avg_latency_ms": statistics.fmean(latencies) if latencies else 0.0,
        "p95_latency_ms": quantile(latencies, 0.95),
        "p99_latency_ms": quantile(latencies, 0.99),
        "wall_seconds": wall,
    }
    misses = [
        {
            "id": row["id"],
            "query": row["query"],
            "category": row["category"],
            "expected": row["expected_document_ids"],
            "hits": row["hit_slugs"][:5],
            "status": row["status"],
            "error": row["error"],
        }
        for row in results
        if (row["expected_document_ids"] and not row["recall5_ok"]) or row["status"] != 200
    ]
    report = {"metrics": metrics, "misses": misses, "results": results}
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"metrics": metrics, "misses": misses[:30]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
