from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

import httpx


class RagFlowError(RuntimeError):
    pass


class RagFlowUnavailableError(RagFlowError):
    def __init__(self, message: str, *, request_id: str, kind: str):
        super().__init__(message)
        self.request_id = request_id
        self.kind = kind


@dataclass(slots=True)
class RagFlowClient:
    base_url: str
    api_key: str
    timeout: float = 30.0
    connect_timeout: float = 5.0
    pool_timeout: float = 5.0
    max_connections: int = 16
    max_keepalive_connections: int = 8
    max_concurrency: int = 8
    _client: httpx.AsyncClient | None = field(default=None, init=False, repr=False)
    _semaphore: asyncio.Semaphore | None = field(default=None, init=False, repr=False)

    def _url(self, path: str) -> str:
        root = self.base_url.rstrip("/")
        if root.endswith("/api/v1"):
            return root + path
        return root + "/api/v1" + path

    def _headers(self, *, json_content: bool = True, request_id: str | None = None) -> dict[str, str]:
        out = {"Authorization": f"Bearer {self.api_key}"}
        if json_content:
            out["Content-Type"] = "application/json"
        if request_id:
            out["X-Request-ID"] = request_id
        return out

    def _http(self) -> httpx.AsyncClient:
        if self._client is None:
            timeout = httpx.Timeout(
                self.timeout,
                connect=min(self.connect_timeout, self.timeout),
                pool=min(self.pool_timeout, self.timeout),
            )
            limits = httpx.Limits(
                max_connections=self.max_connections,
                max_keepalive_connections=min(self.max_keepalive_connections, self.max_connections),
            )
            self._client = httpx.AsyncClient(timeout=timeout, limits=limits)
        return self._client

    def _gate(self) -> asyncio.Semaphore:
        if self._semaphore is None:
            self._semaphore = asyncio.Semaphore(self.max_concurrency)
        return self._semaphore

    async def aclose(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def _request(
        self, method: str, path: str, *, request_id: str | None = None, **kwargs: Any
    ) -> httpx.Response:
        rid = request_id or uuid4().hex
        headers = kwargs.pop("headers", None) or self._headers(request_id=rid)
        try:
            async with asyncio.timeout(self.timeout):
                async with self._gate():
                    response = await self._http().request(method, self._url(path), headers=headers, **kwargs)
        except asyncio.CancelledError:
            raise
        except (TimeoutError, httpx.TimeoutException) as exc:
            raise RagFlowUnavailableError("RAGFlow timeout", request_id=rid, kind="timeout") from exc
        except (httpx.ConnectError, httpx.RemoteProtocolError, httpx.NetworkError) as exc:
            raise RagFlowUnavailableError("RAGFlow network unavailable", request_id=rid, kind="network") from exc
        if response.status_code >= 500:
            raise RagFlowUnavailableError(
                f"RAGFlow upstream HTTP {response.status_code}", request_id=rid, kind="upstream_5xx"
            )
        return response

    @staticmethod
    def _unwrap(response: httpx.Response) -> Any:
        try:
            response.raise_for_status()
            body = response.json()
        except httpx.HTTPStatusError as exc:
            # 4xx (sai API key, dataset không tồn tại...) là lỗi giao thức/cấu hình upstream: map về RagFlowError
            # để API trả 502 có kiểm soát thay vì 500. 5xx đã được _request chuyển thành Unavailable.
            raise RagFlowError(f"RAGFlow upstream HTTP {exc.response.status_code}") from exc
        except ValueError as exc:
            raise RagFlowError("RAGFlow trả response không phải JSON") from exc
        if not isinstance(body, dict):
            raise RagFlowError("RAGFlow trả response không phải object")
        if body.get("code") != 0:
            raise RagFlowError(str(body.get("message") or body.get("data") or "RAGFlow error"))
        return body.get("data")

    async def retrieve(
        self,
        *,
        question: str,
        dataset_id: str,
        page_size: int,
        similarity_threshold: float,
        vector_similarity_weight: float,
        keyword: bool,
        rerank_id: str = "",
        request_id: str | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "question": question,
            "dataset_ids": [dataset_id],
            "page": 1,
            "page_size": page_size,
            "rerank_candidates_count": max(page_size, 64),
            "similarity_threshold": similarity_threshold,
            "vector_similarity_weight": vector_similarity_weight,
            "keyword": keyword,
        }
        if rerank_id:
            payload["rerank_id"] = rerank_id
        response = await self._request("POST", "/retrieval", request_id=request_id, json=payload)
        data = self._unwrap(response)
        return data if isinstance(data, dict) else {}

    async def upload_document(self, *, dataset_id: str, name: str, content: bytes) -> str:
        files = {"file": (name, content, "text/plain; charset=utf-8")}
        form = {"display_name": name}
        response = await self._request(
            "POST",
            f"/datasets/{dataset_id}/documents",
            headers=self._headers(json_content=False),
            files=files,
            data=form,
        )
        data = self._unwrap(response)
        if not isinstance(data, list) or not data or not isinstance(data[0], dict) or not data[0].get("id"):
            raise RagFlowError("upload document thành công nhưng không có document id")
        return str(data[0]["id"])

    async def add_chunk(
        self,
        *,
        dataset_id: str,
        document_id: str,
        content: str,
        important_keywords: list[str],
        tags: list[str],
    ) -> str:
        payload = {
            "content": content,
            "important_keywords": important_keywords[:64],
            "tag_kwd": tags[:64],
        }
        response = await self._request(
            "POST", f"/datasets/{dataset_id}/documents/{document_id}/chunks", json=payload
        )
        data = self._unwrap(response)
        if not isinstance(data, dict):
            raise RagFlowError("add chunk thành công nhưng response không hợp lệ")
        chunk = data.get("chunk")
        if not isinstance(chunk, dict) or not chunk.get("id"):
            raise RagFlowError("add chunk thành công nhưng không có chunk id")
        return str(chunk["id"])

    async def delete_documents(self, *, dataset_id: str, document_ids: list[str]) -> None:
        if not document_ids:
            return
        response = await self._request(
            "DELETE", f"/datasets/{dataset_id}/documents", json={"ids": document_ids, "delete_all": False}
        )
        self._unwrap(response)

    async def delete_all_documents(self, *, dataset_id: str) -> None:
        """Clear a derived dataset before a full source replacement.

        PostgreSQL remains the source of truth, but deleting the remote documents first prevents
        orphaned stale chunks from occupying RAGFlow's top-k after a full Governance reset.
        """
        response = await self._request(
            "DELETE", f"/datasets/{dataset_id}/documents", json={"delete_all": True}
        )
        self._unwrap(response)
