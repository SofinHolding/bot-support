from __future__ import annotations

import asyncio
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

from ..db import Database
from .client import RagFlowClient


class RagFlowSyncWorker:
    def __init__(self, *, db: Database, client: RagFlowClient, dataset_id: str):
        self.db = db
        self.client = client
        self.dataset_id = dataset_id

    async def run_once(self) -> bool:
        job = await self._claim()
        if job is None:
            return False
        try:
            if job["action"] == "upsert":
                await self._upsert(job)
            else:
                await self._delete(job)
            await self._complete(int(job["id"]))
        except Exception as exc:
            await self._fail(int(job["id"]), int(job["attempts"]), str(exc))
        return True

    async def _claim(self) -> dict[str, Any] | None:
        async with self.db.transaction() as conn:
            row = await conn.fetchrow(
                """
                SELECT * FROM knowledge_sync_outbox
                WHERE status IN ('pending','failed') AND next_attempt_at <= now()
                ORDER BY id
                FOR UPDATE SKIP LOCKED
                LIMIT 1
                """
            )
            if row is None:
                return None
            await conn.execute(
                "UPDATE knowledge_sync_outbox SET status='processing', attempts=attempts+1, "
                "updated_at=now() WHERE id=$1",
                row["id"],
            )
            data = dict(row)
            data["attempts"] = int(row["attempts"]) + 1
            return data

    async def _upsert(self, job: dict[str, Any]) -> None:
        version_id: UUID = job["version_id"]
        async with self.db.connection() as conn:
            version = await conn.fetchrow(
                """
                SELECT v.*,u.knowledge_key,u.scope_key
                FROM knowledge_versions v JOIN knowledge_units u ON u.id=v.knowledge_unit_id
                WHERE v.id=$1
                """,
                version_id,
            )
            mapping = await conn.fetchrow("SELECT * FROM knowledge_ragflow_sync WHERE version_id=$1", version_id)
        # Outbox cũ có thể tới sau một supersede khác: không được tái-index version không còn active.
        if version is None or version["status"] != "active":
            if mapping and mapping["document_id"]:
                await self.client.delete_documents(
                    dataset_id=self.dataset_id,
                    document_ids=[str(mapping["document_id"])],
                )
            async with self.db.connection() as conn:
                await conn.execute("DELETE FROM knowledge_ragflow_sync WHERE version_id=$1", version_id)
            return

        if (
            mapping
            and mapping["state"] == "synced"
            and mapping["content_hash"] == version["content_hash"]
            and int(mapping["generation"]) == int(version["generation"])
            and mapping["document_id"]
        ):
            return

        if mapping and mapping["document_id"]:
            await self.client.delete_documents(dataset_id=self.dataset_id, document_ids=[str(mapping["document_id"])])

        name = f"{version['knowledge_key']}--v{version['version_number']}--{version_id}.txt"
        payload = (
            f"{version['canonical_title']}\n\n"
            f"{version['canonical_summary']}\n\n"
            f"{version['content']}"
        ).strip()
        document_id = await self.client.upload_document(
            dataset_id=self.dataset_id,
            name=name,
            content=payload.encode("utf-8"),
        )
        try:
            await self.client.add_chunk(
                dataset_id=self.dataset_id,
                document_id=document_id,
                content=str(version["content"]),
                important_keywords=[str(x) for x in (version["keywords"] or [])],
                tags=[
                    f"knowledge_key:{version['knowledge_key']}",
                    f"scope:{version['scope_key']}",
                    f"version:{version_id}",
                    "status:active",
                ],
            )
        except Exception:
            await self.client.delete_documents(dataset_id=self.dataset_id, document_ids=[document_id])
            raise

        async with self.db.connection() as conn:
            await conn.execute(
                """
                INSERT INTO knowledge_ragflow_sync
                  (version_id,dataset_id,document_id,content_hash,generation,state,last_error,synced_at,updated_at)
                VALUES($1,$2,$3,$4,$5,'synced',NULL,now(),now())
                ON CONFLICT(version_id) DO UPDATE SET
                  dataset_id=EXCLUDED.dataset_id,document_id=EXCLUDED.document_id,content_hash=EXCLUDED.content_hash,
                  generation=EXCLUDED.generation,state='synced',last_error=NULL,synced_at=now(),updated_at=now()
                """,
                version_id,
                self.dataset_id,
                document_id,
                version["content_hash"],
                int(version["generation"]),
            )

    async def _delete(self, job: dict[str, Any]) -> None:
        version_id: UUID = job["version_id"]
        async with self.db.connection() as conn:
            mapping = await conn.fetchrow("SELECT * FROM knowledge_ragflow_sync WHERE version_id=$1", version_id)
        if mapping and mapping["document_id"]:
            await self.client.delete_documents(dataset_id=self.dataset_id, document_ids=[str(mapping["document_id"])])
        async with self.db.connection() as conn:
            await conn.execute("DELETE FROM knowledge_ragflow_sync WHERE version_id=$1", version_id)

    async def _complete(self, job_id: int) -> None:
        async with self.db.connection() as conn:
            await conn.execute(
                "UPDATE knowledge_sync_outbox SET status='done',last_error=NULL,updated_at=now() WHERE id=$1",
                job_id,
            )

    async def _fail(self, job_id: int, attempts: int, error: str) -> None:
        delay = min(300, max(2, 2 ** min(attempts, 8)))
        next_at = datetime.now(UTC) + timedelta(seconds=delay)
        async with self.db.connection() as conn:
            await conn.execute(
                """
                UPDATE knowledge_sync_outbox
                SET status='failed',last_error=$2,next_attempt_at=$3,updated_at=now()
                WHERE id=$1
                """,
                job_id,
                error[:1000],
                next_at,
            )

    async def run_forever(self, *, idle_seconds: float = 1.0) -> None:
        while True:
            worked = await self.run_once()
            if not worked:
                await asyncio.sleep(idle_seconds)
