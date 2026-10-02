from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException
from interlink_support.api import SearchRequest, retrieval_search
from interlink_support.ragflow.client import RagFlowError, RagFlowUnavailableError


class _UnavailableRetrieval:
    async def search(self, query: str, k: int, query_lang: str | None, *, request_id: str | None = None):
        raise RagFlowUnavailableError("timeout", request_id=request_id or "missing", kind="timeout")


class _ProtocolErrorRetrieval:
    async def search(self, query: str, k: int, query_lang: str | None, *, request_id: str | None = None):
        raise RagFlowError("bad upstream envelope")


def _request(retrieval, request_id: str = "audit-rid"):
    return SimpleNamespace(
        headers={"X-Request-ID": request_id},
        app=SimpleNamespace(state=SimpleNamespace(retrieval=retrieval)),
    )


@pytest.mark.asyncio
async def test_retrieval_timeout_is_controlled_503_with_correlation_id():
    with pytest.raises(HTTPException) as info:
        await retrieval_search(_request(_UnavailableRetrieval()), SearchRequest(query="hello", k=5))
    assert info.value.status_code == 503
    assert info.value.detail == "retrieval service temporarily unavailable"
    assert info.value.headers == {"X-Request-ID": "audit-rid", "Retry-After": "2"}


@pytest.mark.asyncio
async def test_retrieval_protocol_failure_is_controlled_502():
    with pytest.raises(HTTPException) as info:
        await retrieval_search(_request(_ProtocolErrorRetrieval()), SearchRequest(query="hello", k=5))
    assert info.value.status_code == 502
    assert info.value.detail == "retrieval upstream error"
    assert info.value.headers == {"X-Request-ID": "audit-rid"}

