from __future__ import annotations

import asyncio

import httpx
import pytest
from interlink_support.ragflow.client import RagFlowClient, RagFlowError, RagFlowUnavailableError


def _response(request: httpx.Request, *, status: int = 200) -> httpx.Response:
    return httpx.Response(status, request=request, json={"code": 0, "data": {"chunks": [], "total": 0}})


async def _retrieve(client: RagFlowClient, request_id: str = "qa-rid"):
    return await client.retrieve(
        question="hello",
        dataset_id="d",
        page_size=5,
        similarity_threshold=0.2,
        vector_similarity_weight=0.5,
        keyword=False,
        request_id=request_id,
    )


@pytest.mark.asyncio
async def test_reuses_http_client_and_forwards_correlation_id():
    seen: list[tuple[str | None, int | None]] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        import json

        payload = json.loads(request.content)
        seen.append((request.headers.get("x-request-id"), payload.get("rerank_candidates_count")))
        return _response(request)

    c = RagFlowClient("http://rag", "token")
    transport = httpx.MockTransport(handler)
    c._client = httpx.AsyncClient(transport=transport)
    original = c._client
    await _retrieve(c, "rid-1")
    await _retrieve(c, "rid-2")
    assert c._client is original
    assert seen == [("rid-1", 64), ("rid-2", 64)]
    await c.aclose()


@pytest.mark.asyncio
async def test_large_page_expands_rerank_candidate_pool():
    import json

    seen: list[dict] = []

    async def handler(request: httpx.Request) -> httpx.Response:
        seen.append(json.loads(request.content))
        return _response(request)

    c = RagFlowClient("http://rag", "token")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await c.retrieve(
        question="hello",
        dataset_id="d",
        page_size=80,
        similarity_threshold=0.2,
        vector_similarity_weight=0.5,
        keyword=False,
    )
    assert seen[0]["rerank_candidates_count"] == 80
    await c.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize("exc", [httpx.ConnectTimeout("connect"), httpx.ReadTimeout("read")])
async def test_timeouts_become_controlled_unavailable(exc: Exception):
    async def handler(request: httpx.Request) -> httpx.Response:
        raise exc

    c = RagFlowClient("http://rag", "token", timeout=0.2)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RagFlowUnavailableError) as info:
        await _retrieve(c, "timeout-rid")
    assert info.value.kind == "timeout"
    assert info.value.request_id == "timeout-rid"
    await c.aclose()


@pytest.mark.asyncio
async def test_connection_reset_becomes_network_unavailable():
    async def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadError("reset", request=request)

    c = RagFlowClient("http://rag", "token")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RagFlowUnavailableError) as info:
        await _retrieve(c)
    assert info.value.kind == "network"
    await c.aclose()


@pytest.mark.asyncio
async def test_5xx_is_controlled_and_not_retried():
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        return _response(request, status=503)

    c = RagFlowClient("http://rag", "token")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RagFlowUnavailableError) as info:
        await _retrieve(c)
    assert info.value.kind == "upstream_5xx"
    assert calls == 1  # no retry storm inside a user request
    await c.aclose()


@pytest.mark.asyncio
async def test_slow_request_obeys_total_budget():
    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(0.08)
        return _response(request)

    c = RagFlowClient("http://rag", "token", timeout=0.02)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RagFlowUnavailableError) as info:
        await _retrieve(c)
    assert info.value.kind == "timeout"
    await c.aclose()


@pytest.mark.asyncio
async def test_cancellation_propagates():
    started = asyncio.Event()

    async def handler(request: httpx.Request) -> httpx.Response:
        started.set()
        await asyncio.sleep(10)
        return _response(request)

    c = RagFlowClient("http://rag", "token", timeout=30)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    task = asyncio.create_task(_retrieve(c))
    await started.wait()
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    await c.aclose()


@pytest.mark.asyncio
async def test_concurrency_gate_and_recovery_after_failure():
    active = 0
    peak = 0
    calls = 0

    async def handler(request: httpx.Request) -> httpx.Response:
        nonlocal active, peak, calls
        calls += 1
        if calls == 1:
            raise httpx.ReadTimeout("temporary", request=request)
        active += 1
        peak = max(peak, active)
        await asyncio.sleep(0.01)
        active -= 1
        return _response(request)

    c = RagFlowClient("http://rag", "token", max_concurrency=2)
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RagFlowUnavailableError):
        await _retrieve(c, "first-fails")
    results = await asyncio.gather(*[_retrieve(c, f"recover-{i}") for i in range(8)])
    assert all(result == {"chunks": [], "total": 0} for result in results)
    assert peak <= 2
    await c.aclose()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "response",
    [
        httpx.Response(401, json={"code": 401, "message": "bad key"}),
        httpx.Response(404, text="not found"),
        httpx.Response(200, text="<html>gateway page</html>"),
    ],
)
async def test_upstream_client_error_or_non_json_is_ragflow_error_not_raw_httpx(response):
    async def handler(request: httpx.Request) -> httpx.Response:
        return response

    c = RagFlowClient("http://rag", "token")
    c._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    with pytest.raises(RagFlowError) as info:
        await _retrieve(c)
    assert not isinstance(info.value, RagFlowUnavailableError)
    await c.aclose()
