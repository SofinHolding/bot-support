from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from uuid import UUID

from pydantic import BaseModel, Field, field_validator


class KnowledgeStatus(StrEnum):
    ACTIVE = "active"
    SUPERSEDED = "superseded"
    CONFLICTED = "conflicted"
    DUPLICATE = "duplicate"
    SHADOW = "shadow"
    REJECTED = "rejected"


class ResolutionAction(StrEnum):
    NEW_ACTIVE = "new_active"
    SUPERSEDE = "supersede"
    DUPLICATE = "duplicate"
    SHADOW = "shadow"
    CONFLICT = "conflict"


class SourceDescriptor(BaseModel):
    file_name: str
    source_type: str = "upload"
    source_priority: int = Field(default=50, ge=0, le=1000)
    uploaded_by: str | None = None
    uploaded_at: datetime
    document_date: datetime | None = None
    effective_from: datetime | None = None
    storage_path: str | None = None
    content_hash: str
    metadata: dict = Field(default_factory=dict)


class ExtractedKnowledgeUnit(BaseModel):
    knowledge_key: str = Field(min_length=3, max_length=180)
    scope_key: str = Field(default="default", min_length=1, max_length=180)
    subject: str = ""
    intent: str = ""
    condition_key: str = ""
    product: str = ""
    platform: str = ""
    region: str = ""
    canonical_title: str = ""
    canonical_summary: str = ""
    keywords: list[str] = Field(default_factory=list)
    language: str = "en"
    content: str = Field(min_length=1)
    effective_from: datetime | None = None
    identity_confidence: float = Field(default=1.0, ge=0, le=1)
    metadata: dict = Field(default_factory=dict)

    @field_validator("knowledge_key", "scope_key")
    @classmethod
    def normalize_keys(cls, value: str) -> str:
        out = value.strip().lower().replace(" ", "_")
        return "".join(ch for ch in out if ch.isalnum() or ch in "._-:")


class ActiveVersionSnapshot(BaseModel):
    id: UUID
    knowledge_unit_id: UUID
    source_id: UUID
    version_number: int
    status: KnowledgeStatus
    content: str
    canonical_title: str
    canonical_summary: str
    keywords: list[str]
    language: str
    source_priority: int
    effective_from: datetime | None
    uploaded_at: datetime
    content_hash: str
    generation: int


class ResolutionDecision(BaseModel):
    action: ResolutionAction
    reason: str


class IngestedVersion(BaseModel):
    version_id: UUID
    knowledge_key: str
    scope_key: str
    version_number: int
    status: KnowledgeStatus
    action: ResolutionAction
    reason: str
    generation: int


class IngestReport(BaseModel):
    source_id: UUID
    file_name: str
    units: list[IngestedVersion] = Field(default_factory=list)

    @property
    def counts(self) -> dict[str, int]:
        out: dict[str, int] = {}
        for unit in self.units:
            out[unit.action.value] = out.get(unit.action.value, 0) + 1
        return out


class RetrievalHit(BaseModel):
    chunkId: str
    docSlug: str
    heading: str = ""
    text: str
    url: str | None = None
    score: float
    lang: str | None = None
