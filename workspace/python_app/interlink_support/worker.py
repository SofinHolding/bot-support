from __future__ import annotations

import asyncio

from .config import get_settings
from .db import Database, apply_migrations
from .ragflow.client import RagFlowClient
from .ragflow.sync import RagFlowSyncWorker


async def _run() -> None:
    settings = get_settings()
    if not settings.RAGFLOW_ENABLED:
        raise RuntimeError(
            "RAGFLOW_ENABLED=false; knowledge worker không khởi động để tránh consume outbox mà không sync"
        )
    if not settings.RAGFLOW_API_KEY or not settings.RAGFLOW_DATASET_ID:
        raise RuntimeError("RAGFLOW_API_KEY và RAGFLOW_DATASET_ID là bắt buộc")
    db = Database(settings.DATABASE_URL)
    await db.open()
    await apply_migrations(db)
    client: RagFlowClient | None = None
    try:
        client = RagFlowClient(
            base_url=settings.RAGFLOW_BASE_URL,
            api_key=settings.RAGFLOW_API_KEY,
            timeout=settings.RAGFLOW_TIMEOUT_SECONDS,
            connect_timeout=settings.RAGFLOW_CONNECT_TIMEOUT_SECONDS,
            pool_timeout=settings.RAGFLOW_POOL_TIMEOUT_SECONDS,
            max_connections=settings.RAGFLOW_MAX_CONNECTIONS,
            max_keepalive_connections=settings.RAGFLOW_MAX_KEEPALIVE_CONNECTIONS,
            max_concurrency=settings.RAGFLOW_MAX_CONCURRENCY,
        )
        worker = RagFlowSyncWorker(db=db, client=client, dataset_id=settings.RAGFLOW_DATASET_ID)
        await worker.run_forever()
    finally:
        if client is not None:
            await client.aclose()
        await db.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
