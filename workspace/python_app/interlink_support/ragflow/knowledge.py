from __future__ import annotations

from uuid import UUID

from ..knowledge.models import RetrievalHit
from ..knowledge.repository import KnowledgeRepository
from .client import RagFlowClient


class RagFlowKnowledge:
    """RAGFlow retrieval + Postgres active-version revalidation.

    RAGFlow là index dẫn xuất nên mọi hit phải được kiểm lại trong Postgres. Nhờ đó một document cũ còn
    tồn tại vài giây trong RAGFlow sau khi supersede cũng không thể trở thành evidence production.
    """

    def __init__(
        self,
        *,
        client: RagFlowClient,
        repo: KnowledgeRepository,
        dataset_id: str,
        similarity_threshold: float,
        vector_weight: float,
        keyword: bool,
        rerank_id: str = "",
    ):
        self.client = client
        self.repo = repo
        self.dataset_id = dataset_id
        self.similarity_threshold = similarity_threshold
        self.vector_weight = vector_weight
        self.keyword = keyword
        self.rerank_id = rerank_id

    async def search(self, query: str, k: int, query_lang: str | None = None) -> list[RetrievalHit]:
        if not query.strip() or k <= 0:
            return []
        data = await self.client.retrieve(
            question=query,
            dataset_id=self.dataset_id,
            page_size=max(k * 4, 20),
            similarity_threshold=self.similarity_threshold,
            vector_similarity_weight=self.vector_weight,
            keyword=self.keyword,
            rerank_id=self.rerank_id,
        )
        chunks = data.get("chunks") if isinstance(data, dict) else None
        if not isinstance(chunks, list):
            return []

        doc_ids = [str(c.get("document_id")) for c in chunks if isinstance(c, dict) and c.get("document_id")]
        active = await self.repo.versions_for_documents(list(dict.fromkeys(doc_ids)))

        # Một knowledge version hiện được sync thành một document + một chunk. Nếu RAGFlow trả nhiều chunk,
        # chỉ lấy score cao nhất của version đó để không chiếm top-k bằng các đoạn cùng nguồn.
        best: dict[UUID, RetrievalHit] = {}
        for chunk in chunks:
            if not isinstance(chunk, dict):
                continue
            document_id = str(chunk.get("document_id") or "")
            row = active.get(document_id)
            if row is None:
                continue
            version_id: UUID = row["id"]
            score = float(chunk.get("similarity") or chunk.get("score") or 0.0)
            hit = RetrievalHit(
                chunkId=f"pykv:{version_id}",
                docSlug=str(row["knowledge_key"]),
                heading=str(row["canonical_title"] or ""),
                text=str(row["content"]),
                score=score,
                lang=str(row["language"] or query_lang or "en"),
            )
            old = best.get(version_id)
            if old is None or hit.score > old.score:
                best[version_id] = hit
        return sorted(best.values(), key=lambda x: x.score, reverse=True)[:k]

    async def by_ids(self, ids: list[str]) -> list[RetrievalHit]:
        parsed: list[UUID] = []
        ordered: list[UUID] = []
        for raw in ids:
            if not raw.startswith("pykv:"):
                continue
            try:
                value = UUID(raw.removeprefix("pykv:"))
            except ValueError:
                continue
            parsed.append(value)
            ordered.append(value)
        rows = await self.repo.get_active_versions(parsed)
        out: list[RetrievalHit] = []
        for version_id in ordered:
            row = rows.get(version_id)
            if row is None:
                continue
            out.append(
                RetrievalHit(
                    chunkId=f"pykv:{version_id}",
                    docSlug=str(row["knowledge_key"]),
                    heading=str(row["canonical_title"] or ""),
                    text=str(row["content"]),
                    score=1.0,
                    lang=str(row["language"] or "en"),
                )
            )
        return out
