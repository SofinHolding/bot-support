from uuid import uuid4

import pytest
from interlink_support.ragflow.knowledge import RagFlowKnowledge


@pytest.mark.asyncio
async def test_exact_customer_phrase_wins_over_vector_similarity() -> None:
    exact_id = uuid4()
    semantic_id = uuid4()

    class Repo:
        async def exact_active_matches(self, query: str, limit: int = 5):
            assert query == "forgot id"
            return [
                {
                    "id": exact_id,
                    "knowledge_key": "support.forgot-id",
                    "canonical_title": "Forgot ID",
                    "content": "Exact answer",
                    "language": "en",
                }
            ]

        async def versions_for_documents(self, document_ids: list[str]):
            return {
                "semantic-doc": {
                    "id": semantic_id,
                    "knowledge_key": "support.other",
                    "canonical_title": "Other",
                    "content": "Semantic answer",
                    "language": "en",
                }
            }

    class Client:
        async def retrieve(self, **_kwargs):
            return {"chunks": [{"document_id": "semantic-doc", "similarity": 0.99}]}

    knowledge = RagFlowKnowledge(
        client=Client(),  # type: ignore[arg-type]
        repo=Repo(),  # type: ignore[arg-type]
        dataset_id="dataset",
        similarity_threshold=0.2,
        vector_weight=0.5,
        keyword=False,
    )
    hits = await knowledge.search("forgot id", 5, "en")
    assert [hit.docSlug for hit in hits[:2]] == ["support.forgot-id", "support.other"]
    assert hits[0].score == 1.05
