from __future__ import annotations

import json
from datetime import UTC, datetime
from uuid import UUID, uuid4

import asyncpg

from ..db import Database
from .extractor import CatalogItem
from .models import (
    ActiveVersionSnapshot,
    ExtractedKnowledgeUnit,
    KnowledgeStatus,
    ResolutionAction,
    SourceDescriptor,
)


def _active(row: asyncpg.Record | None) -> ActiveVersionSnapshot | None:
    if row is None:
        return None
    return ActiveVersionSnapshot(
        id=row["id"],
        knowledge_unit_id=row["knowledge_unit_id"],
        source_id=row["source_id"],
        version_number=row["version_number"],
        status=KnowledgeStatus(row["status"]),
        content=row["content"],
        canonical_title=row["canonical_title"],
        canonical_summary=row["canonical_summary"],
        keywords=list(row["keywords"] or []),
        language=row["language"],
        source_priority=row["source_priority"],
        effective_from=row["effective_from"],
        uploaded_at=row["uploaded_at"],
        content_hash=row["content_hash"],
        generation=row["generation"],
    )


class KnowledgeRepository:
    def __init__(self, db: Database):
        self.db = db

    async def list_catalog(self, limit: int = 500) -> list[CatalogItem]:
        async with self.db.connection() as conn:
            rows = await conn.fetch(
                """
                SELECT u.knowledge_key, u.scope_key, v.canonical_title, v.canonical_summary
                FROM knowledge_units u
                JOIN knowledge_versions v ON v.knowledge_unit_id=u.id AND v.status='active'
                ORDER BY u.updated_at DESC
                LIMIT $1
                """,
                limit,
            )
        return [
            CatalogItem(
                knowledge_key=r["knowledge_key"],
                scope_key=r["scope_key"],
                title=r["canonical_title"],
                summary=r["canonical_summary"],
            )
            for r in rows
        ]

    async def create_source(self, source_id: UUID, source: SourceDescriptor) -> None:
        async with self.db.connection() as conn:
            await conn.execute(
                """
                INSERT INTO knowledge_sources
                  (id,file_name,source_type,source_priority,storage_path,content_hash,uploaded_by,uploaded_at,
                   document_date,effective_from,metadata)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
                """,
                source_id,
                source.file_name,
                source.source_type,
                source.source_priority,
                source.storage_path,
                source.content_hash,
                source.uploaded_by,
                source.uploaded_at,
                source.document_date,
                source.effective_from,
                json.dumps(source.metadata, ensure_ascii=False),
            )

    async def lock_or_create_unit(self, conn: asyncpg.Connection, unit: ExtractedKnowledgeUnit) -> UUID:
        new_id = uuid4()
        await conn.execute(
            """
            INSERT INTO knowledge_units
              (id,knowledge_key,scope_key,subject,intent,condition_key,product,platform,region,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
            ON CONFLICT (knowledge_key,scope_key) DO UPDATE SET updated_at=now()
            """,
            new_id,
            unit.knowledge_key,
            unit.scope_key,
            unit.subject,
            unit.intent,
            unit.condition_key,
            unit.product,
            unit.platform,
            unit.region,
            json.dumps(unit.metadata, ensure_ascii=False),
        )
        row = await conn.fetchrow(
            "SELECT id FROM knowledge_units WHERE knowledge_key=$1 AND scope_key=$2 FOR UPDATE",
            unit.knowledge_key,
            unit.scope_key,
        )
        if row is None:
            raise RuntimeError("không tạo/lock được knowledge unit")
        return row["id"]

    async def active_for_update(self, conn: asyncpg.Connection, unit_id: UUID) -> ActiveVersionSnapshot | None:
        return _active(
            await conn.fetchrow(
                "SELECT * FROM knowledge_versions WHERE knowledge_unit_id=$1 AND status='active' FOR UPDATE",
                unit_id,
            )
        )

    async def next_version_number(self, conn: asyncpg.Connection, unit_id: UUID) -> int:
        n = await conn.fetchval(
            "SELECT COALESCE(MAX(version_number),0)+1 FROM knowledge_versions WHERE knowledge_unit_id=$1",
            unit_id,
        )
        return int(n)

    async def insert_version(
        self,
        conn: asyncpg.Connection,
        *,
        version_id: UUID,
        unit_id: UUID,
        source_id: UUID,
        version_number: int,
        status: KnowledgeStatus,
        unit: ExtractedKnowledgeUnit,
        source_priority: int,
        effective_from: datetime | None,
        uploaded_at: datetime,
        content_hash: str,
        supersedes_id: UUID | None,
        action: ResolutionAction,
        reason: str,
    ) -> int:
        row = await conn.fetchrow(
            """
            INSERT INTO knowledge_versions
              (id,knowledge_unit_id,source_id,version_number,status,content,canonical_title,canonical_summary,
               keywords,language,source_priority,effective_from,uploaded_at,supersedes_id,content_hash,
               identity_confidence,resolution_reason,resolution_action,metadata)
            VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19::jsonb)
            RETURNING generation
            """,
            version_id,
            unit_id,
            source_id,
            version_number,
            status.value,
            unit.content,
            unit.canonical_title,
            unit.canonical_summary,
            unit.keywords,
            unit.language,
            source_priority,
            effective_from,
            uploaded_at,
            supersedes_id,
            content_hash,
            unit.identity_confidence,
            reason,
            action.value,
            json.dumps(unit.metadata, ensure_ascii=False),
        )
        return int(row["generation"])

    async def supersede(
        self,
        conn: asyncpg.Connection,
        active: ActiveVersionSnapshot,
        *,
        effective_to: datetime,
    ) -> None:
        await conn.execute(
            "UPDATE knowledge_versions SET status='superseded', effective_to=$2 WHERE id=$1 AND status='active'",
            active.id,
            effective_to,
        )

    async def enqueue_sync(self, conn: asyncpg.Connection, action: str, version_id: UUID, generation: int) -> None:
        await conn.execute(
            """
            INSERT INTO knowledge_sync_outbox(action,version_id,generation)
            VALUES($1,$2,$3)
            ON CONFLICT(action,version_id,generation) DO NOTHING
            """,
            action,
            version_id,
            generation,
        )

    async def create_conflict(
        self,
        conn: asyncpg.Connection,
        *,
        unit_id: UUID,
        active_id: UUID | None,
        candidate_id: UUID,
        reason: str,
    ) -> None:
        await conn.execute(
            """
            INSERT INTO knowledge_conflicts(knowledge_unit_id,active_version_id,candidate_version_id,reason)
            VALUES($1,$2,$3,$4)
            ON CONFLICT (candidate_version_id) WHERE status='open' DO NOTHING
            """,
            unit_id,
            active_id,
            candidate_id,
            reason,
        )

    async def get_active_versions(self, ids: list[UUID]) -> dict[UUID, asyncpg.Record]:
        if not ids:
            return {}
        async with self.db.connection() as conn:
            rows = await conn.fetch(
                """
                SELECT v.*, u.knowledge_key, u.scope_key
                FROM knowledge_versions v
                JOIN knowledge_units u ON u.id=v.knowledge_unit_id
                WHERE v.id=ANY($1::uuid[]) AND v.status='active'
                """,
                ids,
            )
        return {r["id"]: r for r in rows}

    async def versions_for_documents(self, document_ids: list[str]) -> dict[str, asyncpg.Record]:
        if not document_ids:
            return {}
        async with self.db.connection() as conn:
            rows = await conn.fetch(
                """
                SELECT s.document_id, v.*, u.knowledge_key, u.scope_key
                FROM knowledge_ragflow_sync s
                JOIN knowledge_versions v ON v.id=s.version_id
                JOIN knowledge_units u ON u.id=v.knowledge_unit_id
                WHERE s.document_id=ANY($1::text[]) AND v.status='active' AND s.state='synced'
                """,
                document_ids,
            )
        return {r["document_id"]: r for r in rows}

    async def list_conflicts(self, limit: int = 100) -> list[dict]:
        async with self.db.connection() as conn:
            rows = await conn.fetch(
                """
                SELECT c.*, u.knowledge_key, u.scope_key
                FROM knowledge_conflicts c
                JOIN knowledge_units u ON u.id=c.knowledge_unit_id
                WHERE c.status='open'
                ORDER BY c.created_at DESC LIMIT $1
                """,
                limit,
            )
        return [dict(r) for r in rows]

    async def rollback(self, *, target_version_id: UUID, by: str) -> UUID:
        now = datetime.now(UTC)
        async with self.db.transaction() as conn:
            target = await conn.fetchrow("SELECT * FROM knowledge_versions WHERE id=$1 FOR UPDATE", target_version_id)
            if target is None:
                raise KeyError("version không tồn tại")
            unit_id = target["knowledge_unit_id"]
            await conn.fetchrow("SELECT id FROM knowledge_units WHERE id=$1 FOR UPDATE", unit_id)
            active = _active(
                await conn.fetchrow(
                    "SELECT * FROM knowledge_versions WHERE knowledge_unit_id=$1 AND status='active' FOR UPDATE",
                    unit_id,
                )
            )
            if active and active.id == target_version_id:
                return target_version_id
            if active:
                await self.supersede(conn, active, effective_to=max(now, active.effective_from or now))
                await self.enqueue_sync(conn, "delete", active.id, active.generation)
            # Rollback tạo version MỚI thay vì sửa lịch sử version cũ.
            new_id = uuid4()
            version_number = await self.next_version_number(conn, unit_id)
            row = await conn.fetchrow(
                """
                INSERT INTO knowledge_versions
                  (id,knowledge_unit_id,source_id,version_number,status,content,canonical_title,canonical_summary,
                   keywords,language,source_priority,effective_from,uploaded_at,supersedes_id,content_hash,
                   identity_confidence,resolution_reason,resolution_action,metadata)
                SELECT $1,knowledge_unit_id,source_id,$2,'active',content,canonical_title,canonical_summary,
                       keywords,language,source_priority,effective_from,$3,$4,content_hash,
                       identity_confidence,$5,'rollback',metadata
                FROM knowledge_versions WHERE id=$6
                RETURNING generation
                """,
                new_id,
                version_number,
                now,
                active.id if active else None,
                f"rollback by {by} to {target_version_id}",
                target_version_id,
            )
            await self.enqueue_sync(conn, "upsert", new_id, int(row["generation"]))
            return new_id
