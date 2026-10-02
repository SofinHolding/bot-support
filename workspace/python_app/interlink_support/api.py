from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Annotated
from uuid import UUID, uuid4

import uvicorn
from fastapi import Depends, FastAPI, File, Form, Header, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from .config import Settings, get_settings
from .db import Database, apply_migrations
from .knowledge.extractor import OpenAICompatibleKnowledgeExtractor
from .knowledge.models import ExtractedKnowledgeUnit, RetrievalHit
from .knowledge.repository import KnowledgeRepository
from .knowledge.service import KnowledgeService
from .ragflow.client import RagFlowClient, RagFlowError, RagFlowUnavailableError
from .ragflow.knowledge import RagFlowKnowledge

log = logging.getLogger("interlink_support.knowledge_api")


class UnitIngestRequest(BaseModel):
    file_name: str = "api.json"
    source_priority: int = Field(default=50, ge=0, le=1000)
    source_type: str = "api"
    uploaded_by: str | None = None
    effective_from: datetime | None = None
    metadata: dict = Field(default_factory=dict)
    units: list[ExtractedKnowledgeUnit]


class SearchRequest(BaseModel):
    query: str = Field(min_length=1, max_length=10_000)
    k: int = Field(default=8, ge=1, le=100)
    queryLang: str | None = None


class ByIdsRequest(BaseModel):
    ids: list[str] = Field(max_length=100)


class RollbackRequest(BaseModel):
    by: str = "system"


def _bearer(authorization: str | None) -> str:
    if not authorization:
        return ""
    prefix = "Bearer "
    return authorization[len(prefix) :].strip() if authorization.startswith(prefix) else ""


async def require_internal_auth(
    settings: Annotated[Settings, Depends(get_settings)],
    authorization: Annotated[str | None, Header()] = None,
) -> None:
    # Dev convenience: empty token means endpoint is unprotected. Production should always set it.
    if settings.INTERNAL_SERVICE_TOKEN and _bearer(authorization) != settings.INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal service token")


def _parse_optional_datetime(value: str | None, field: str) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=f"{field} không hợp lệ") from exc


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    db = Database(settings.DATABASE_URL)
    await db.open()
    await apply_migrations(db)
    repo = KnowledgeRepository(db)
    extractor = None
    if settings.KNOWLEDGE_LLM_BASE_URL and settings.KNOWLEDGE_LLM_MODEL:
        extractor = OpenAICompatibleKnowledgeExtractor(
            base_url=settings.KNOWLEDGE_LLM_BASE_URL,
            api_key=settings.KNOWLEDGE_LLM_API_KEY,
            model=settings.KNOWLEDGE_LLM_MODEL,
        )
    knowledge = KnowledgeService(
        repo=repo,
        extractor=extractor,
        identity_min_confidence=settings.KNOWLEDGE_IDENTITY_MIN_CONFIDENCE,
        source_dir=settings.KNOWLEDGE_SOURCE_DIR,
    )
    retrieval = None
    if settings.RAGFLOW_ENABLED and settings.RAGFLOW_API_KEY and settings.RAGFLOW_DATASET_ID:
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
        retrieval = RagFlowKnowledge(
            client=client,
            repo=repo,
            dataset_id=settings.RAGFLOW_DATASET_ID,
            similarity_threshold=settings.RAGFLOW_SIMILARITY_THRESHOLD,
            vector_weight=settings.RAGFLOW_VECTOR_WEIGHT,
            keyword=settings.RAGFLOW_KEYWORD,
            rerank_id=settings.RAGFLOW_RERANK_ID,
        )
    app.state.db = db
    app.state.repo = repo
    app.state.knowledge = knowledge
    app.state.retrieval = retrieval
    try:
        yield
    finally:
        if retrieval is not None:
            await retrieval.client.aclose()
        await db.close()


app = FastAPI(title="InterLink Knowledge Control Plane", version="0.1.0", lifespan=lifespan)


@app.get("/healthz")
async def healthz(request: Request) -> dict:
    db: Database = request.app.state.db
    async with db.connection() as conn:
        await conn.fetchval("SELECT 1")
    return {"ok": True, "ragflow": request.app.state.retrieval is not None}


@app.post("/v1/knowledge/upload", dependencies=[Depends(require_internal_auth)])
async def upload_knowledge(
    request: Request,
    file: Annotated[UploadFile, File()],
    source_priority: Annotated[int | None, Form()] = None,
    source_type: Annotated[str, Form()] = "upload",
    uploaded_by: Annotated[str | None, Form()] = None,
    document_date: Annotated[str | None, Form()] = None,
    effective_from: Annotated[str | None, Form()] = None,
) -> dict:
    settings = get_settings()
    data = await file.read(settings.KNOWLEDGE_MAX_UPLOAD_BYTES + 1)
    if len(data) > settings.KNOWLEDGE_MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="file vượt giới hạn upload")
    service: KnowledgeService = request.app.state.knowledge
    try:
        report = await service.ingest_upload(
            file_name=file.filename or "upload.bin",
            data=data,
            source_priority=(
                source_priority if source_priority is not None else settings.KNOWLEDGE_DEFAULT_SOURCE_PRIORITY
            ),
            source_type=source_type,
            uploaded_by=uploaded_by,
            document_date=_parse_optional_datetime(document_date, "document_date"),
            effective_from=_parse_optional_datetime(effective_from, "effective_from"),
        )
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {**report.model_dump(mode="json"), "counts": report.counts}


@app.post("/v1/knowledge/units", dependencies=[Depends(require_internal_auth)])
async def ingest_units(request: Request, body: UnitIngestRequest) -> dict:
    service: KnowledgeService = request.app.state.knowledge
    report = await service.ingest_units(
        file_name=body.file_name,
        units=body.units,
        source_priority=body.source_priority,
        source_type=body.source_type,
        uploaded_by=body.uploaded_by,
        effective_from=body.effective_from,
        metadata=body.metadata,
    )
    return {**report.model_dump(mode="json"), "counts": report.counts}


@app.get("/v1/knowledge/conflicts", dependencies=[Depends(require_internal_auth)])
async def conflicts(request: Request, limit: int = 100) -> list[dict]:
    repo: KnowledgeRepository = request.app.state.repo
    rows = await repo.list_conflicts(max(1, min(limit, 500)))
    # FastAPI handles datetime/UUID in response serialization when using jsonable encoder.
    return rows


@app.post("/v1/knowledge/rollback/{version_id}", dependencies=[Depends(require_internal_auth)])
async def rollback(request: Request, version_id: UUID, body: RollbackRequest) -> dict:
    repo: KnowledgeRepository = request.app.state.repo
    try:
        new_id = await repo.rollback(target_version_id=version_id, by=body.by)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"ok": True, "active_version_id": str(new_id)}


@app.post("/v1/retrieval/search", dependencies=[Depends(require_internal_auth)])
async def retrieval_search(request: Request, body: SearchRequest) -> list[RetrievalHit]:
    retrieval: RagFlowKnowledge | None = request.app.state.retrieval
    if retrieval is None:
        raise HTTPException(status_code=503, detail="RAGFlow retrieval chưa được cấu hình")
    request_id = request.headers.get("X-Request-ID") or uuid4().hex
    try:
        return await retrieval.search(body.query, body.k, body.queryLang, request_id=request_id)
    except RagFlowUnavailableError as exc:
        log.warning("RAGFlow retrieval unavailable kind=%s request_id=%s", exc.kind, exc.request_id)
        raise HTTPException(
            status_code=503,
            detail="retrieval service temporarily unavailable",
            headers={"X-Request-ID": exc.request_id, "Retry-After": "2"},
        ) from exc
    except RagFlowError as exc:
        log.error("RAGFlow retrieval protocol error request_id=%s error=%s", request_id, str(exc)[:240])
        raise HTTPException(
            status_code=502,
            detail="retrieval upstream error",
            headers={"X-Request-ID": request_id},
        ) from exc


@app.post("/v1/retrieval/by-ids", dependencies=[Depends(require_internal_auth)])
async def retrieval_by_ids(request: Request, body: ByIdsRequest) -> list[RetrievalHit]:
    retrieval: RagFlowKnowledge | None = request.app.state.retrieval
    if retrieval is None:
        raise HTTPException(status_code=503, detail="RAGFlow retrieval chưa được cấu hình")
    return await retrieval.by_ids(body.ids)


def run() -> None:
    settings = get_settings()
    uvicorn.run(
        "interlink_support.api:app",
        host=settings.PYTHON_SERVICE_HOST,
        port=settings.PYTHON_SERVICE_PORT,
        reload=False,
    )


if __name__ == "__main__":
    run()
