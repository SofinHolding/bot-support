from __future__ import annotations

import hashlib
import re
from datetime import UTC, datetime
from pathlib import Path
from uuid import UUID, uuid4

from .documents import extract_text
from .extractor import OpenAICompatibleKnowledgeExtractor
from .models import (
    ExtractedKnowledgeUnit,
    IngestedVersion,
    IngestReport,
    KnowledgeStatus,
    ResolutionAction,
    SourceDescriptor,
)
from .precedence import CandidateFacts, decide_precedence
from .repository import KnowledgeRepository


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    normalized = re.sub(r"\s+", " ", text.strip())
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()


def safe_file_name(name: str) -> str:
    base = Path(name).name
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._")
    return cleaned[:180] or "upload.bin"


class KnowledgeService:
    def __init__(
        self,
        *,
        repo: KnowledgeRepository,
        extractor: OpenAICompatibleKnowledgeExtractor | None,
        identity_min_confidence: float,
        source_dir: str,
    ):
        self.repo = repo
        self.extractor = extractor
        self.identity_min_confidence = identity_min_confidence
        self.source_dir = Path(source_dir)

    async def ingest_upload(
        self,
        *,
        file_name: str,
        data: bytes,
        source_priority: int,
        source_type: str = "upload",
        uploaded_by: str | None = None,
        document_date: datetime | None = None,
        effective_from: datetime | None = None,
        metadata: dict | None = None,
    ) -> IngestReport:
        if not data:
            raise ValueError("file rỗng")
        text = extract_text(file_name, data).strip()
        if not text:
            raise ValueError("không trích xuất được nội dung chữ từ file")
        if self.extractor is None:
            raise RuntimeError("chưa cấu hình KNOWLEDGE_LLM_BASE_URL / KNOWLEDGE_LLM_MODEL")

        catalog = await self.repo.list_catalog()
        units = await self.extractor.extract(text, catalog)
        if not units:
            raise ValueError("không trích xuất được knowledge unit nào")

        source_id = uuid4()
        uploaded_at = datetime.now(UTC)
        self.source_dir.mkdir(parents=True, exist_ok=True)
        stored_name = f"{source_id}-{safe_file_name(file_name)}"
        stored_path = self.source_dir / stored_name
        stored_path.write_bytes(data)

        source = SourceDescriptor(
            file_name=file_name,
            source_type=source_type,
            source_priority=source_priority,
            uploaded_by=uploaded_by,
            uploaded_at=uploaded_at,
            document_date=document_date,
            effective_from=effective_from,
            storage_path=str(stored_path),
            content_hash=sha256_bytes(data),
            metadata=metadata or {},
        )
        await self.repo.create_source(source_id, source)

        report = IngestReport(source_id=source_id, file_name=file_name)
        for unit in units:
            report.units.append(
                await self._resolve_one(
                    source_id=source_id,
                    source=source,
                    unit=unit,
                )
            )
        return report

    async def ingest_units(
        self,
        *,
        file_name: str,
        units: list[ExtractedKnowledgeUnit],
        source_priority: int,
        source_type: str = "api",
        uploaded_by: str | None = None,
        effective_from: datetime | None = None,
        metadata: dict | None = None,
    ) -> IngestReport:
        """Test/internal path: caller đã có atomic units; vẫn đi qua cùng precedence + transaction."""
        source_id = uuid4()
        uploaded_at = datetime.now(UTC)
        joined = "\n\n".join(u.content for u in units)
        source = SourceDescriptor(
            file_name=file_name,
            source_type=source_type,
            source_priority=source_priority,
            uploaded_by=uploaded_by,
            uploaded_at=uploaded_at,
            effective_from=effective_from,
            content_hash=sha256_text(joined),
            metadata=metadata or {},
        )
        await self.repo.create_source(source_id, source)
        report = IngestReport(source_id=source_id, file_name=file_name)
        for unit in units:
            report.units.append(await self._resolve_one(source_id=source_id, source=source, unit=unit))
        return report

    async def _resolve_one(
        self,
        *,
        source_id: UUID,
        source: SourceDescriptor,
        unit: ExtractedKnowledgeUnit,
    ) -> IngestedVersion:
        content_hash = sha256_text(unit.content)
        effective = unit.effective_from or source.effective_from or source.document_date
        async with self.repo.db.transaction() as conn:
            unit_id = await self.repo.lock_or_create_unit(conn, unit)
            active = await self.repo.active_for_update(conn, unit_id)
            decision = decide_precedence(
                active,
                CandidateFacts(
                    content_hash=content_hash,
                    source_priority=source.source_priority,
                    effective_from=effective,
                    uploaded_at=source.uploaded_at,
                    identity_confidence=unit.identity_confidence,
                ),
                identity_min_confidence=self.identity_min_confidence,
            )
            version_number = await self.repo.next_version_number(conn, unit_id)
            version_id = uuid4()

            status = {
                ResolutionAction.NEW_ACTIVE: KnowledgeStatus.ACTIVE,
                ResolutionAction.SUPERSEDE: KnowledgeStatus.ACTIVE,
                ResolutionAction.DUPLICATE: KnowledgeStatus.DUPLICATE,
                ResolutionAction.SHADOW: KnowledgeStatus.SHADOW,
                ResolutionAction.CONFLICT: KnowledgeStatus.CONFLICTED,
            }[decision.action]

            if decision.action == ResolutionAction.SUPERSEDE and active is not None:
                # Đổi active trong CÙNG transaction: không có cửa sổ hai version cùng active.
                requested_end = effective or source.uploaded_at
                # Nguồn authority cao hơn có thể được upload muộn nhưng mang effective date cũ hơn active.
                # Không được tạo effective_to < effective_from của bản đang active (DB cũng chặn bất biến này).
                active_start = active.effective_from or requested_end
                await self.repo.supersede(conn, active, effective_to=max(requested_end, active_start))
                await self.repo.enqueue_sync(conn, "delete", active.id, active.generation)

            generation = await self.repo.insert_version(
                conn,
                version_id=version_id,
                unit_id=unit_id,
                source_id=source_id,
                version_number=version_number,
                status=status,
                unit=unit,
                source_priority=source.source_priority,
                effective_from=effective,
                uploaded_at=source.uploaded_at,
                content_hash=content_hash,
                supersedes_id=active.id if decision.action == ResolutionAction.SUPERSEDE and active else None,
                action=decision.action,
                reason=decision.reason,
            )

            if status == KnowledgeStatus.ACTIVE:
                await self.repo.enqueue_sync(conn, "upsert", version_id, generation)
            elif status == KnowledgeStatus.CONFLICTED:
                await self.repo.create_conflict(
                    conn,
                    unit_id=unit_id,
                    active_id=active.id if active else None,
                    candidate_id=version_id,
                    reason=decision.reason,
                )

        return IngestedVersion(
            version_id=version_id,
            knowledge_key=unit.knowledge_key,
            scope_key=unit.scope_key,
            version_number=version_number,
            status=status,
            action=decision.action,
            reason=decision.reason,
            generation=generation,
        )
