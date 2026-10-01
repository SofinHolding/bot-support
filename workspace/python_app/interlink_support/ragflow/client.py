from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import httpx


class RagFlowError(RuntimeError):
    pass


@dataclass(slots=True)
class RagFlowClient:
    base_url: str
    api_key: str
    timeout: float = 30.0

    def _url(self, path: str) -> str:
        root = self.base_url.rstrip("/")
        if root.endswith("/api/v1"):
            return root + path
        return root + "/api/v1" + path

    def _headers(self, *, json_content: bool = True) -> dict[str, str]:
        out = {"Authorization": f"Bearer {self.api_key}"}
        if json_content:
            out["Content-Type"] = "application/json"
        return out

    @staticmethod
    def _unwrap(response: httpx.Response) -> Any:
        response.raise_for_status()
        body = response.json()
        if not isinstance(body, dict):
            raise RagFlowError("RAGFlow trả response không phải object")
        if body.get("code") != 0:
            raise RagFlowError(str(body.get("message") or body.get("data") or "RAGFlow error"))
        return body.get("data")

    async def retrieve(
        self,
        *,
        question: str,
        dataset_id: str,
        page_size: int,
        similarity_threshold: float,
        vector_similarity_weight: float,
        keyword: bool,
        rerank_id: str = "",
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "question": question,
            "dataset_ids": [dataset_id],
            "page": 1,
            "page_size": page_size,
            "similarity_threshold": similarity_threshold,
            "vector_similarity_weight": vector_similarity_weight,
            "keyword": keyword,
        }
        if rerank_id:
            payload["rerank_id"] = rerank_id
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(self._url("/retrieval"), headers=self._headers(), json=payload)
        data = self._unwrap(response)
        return data if isinstance(data, dict) else {}

    async def upload_document(self, *, dataset_id: str, name: str, content: bytes) -> str:
        files = {"file": (name, content, "text/plain; charset=utf-8")}
        form = {"display_name": name}
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                self._url(f"/datasets/{dataset_id}/documents"),
                headers=self._headers(json_content=False),
                files=files,
                data=form,
            )
        data = self._unwrap(response)
        if not isinstance(data, list) or not data or not isinstance(data[0], dict) or not data[0].get("id"):
            raise RagFlowError("upload document thành công nhưng không có document id")
        return str(data[0]["id"])

    async def add_chunk(
        self,
        *,
        dataset_id: str,
        document_id: str,
        content: str,
        important_keywords: list[str],
        tags: list[str],
    ) -> str:
        payload = {
            "content": content,
            "important_keywords": important_keywords[:64],
            "tag_kwd": tags[:64],
        }
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.post(
                self._url(f"/datasets/{dataset_id}/documents/{document_id}/chunks"),
                headers=self._headers(),
                json=payload,
            )
        data = self._unwrap(response)
        if not isinstance(data, dict):
            raise RagFlowError("add chunk thành công nhưng response không hợp lệ")
        chunk = data.get("chunk")
        if not isinstance(chunk, dict) or not chunk.get("id"):
            raise RagFlowError("add chunk thành công nhưng không có chunk id")
        return str(chunk["id"])

    async def delete_documents(self, *, dataset_id: str, document_ids: list[str]) -> None:
        if not document_ids:
            return
        async with httpx.AsyncClient(timeout=self.timeout) as client:
            response = await client.request(
                "DELETE",
                self._url(f"/datasets/{dataset_id}/documents"),
                headers=self._headers(),
                json={"ids": document_ids, "delete_all": False},
            )
        self._unwrap(response)
