from __future__ import annotations

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

import asyncpg


def normalize_pg_url(url: str) -> str:
    if url.startswith("postgresql://"):
        return url
    if url.startswith("postgres://"):
        return "postgresql://" + url[len("postgres://") :]
    if url.startswith("pglite:"):
        raise ValueError("Python control-plane yêu cầu PostgreSQL thật; pglite chỉ còn dùng cho test Node legacy")
    return url


class Database:
    def __init__(self, url: str, *, min_size: int = 1, max_size: int = 10):
        self.url = normalize_pg_url(url)
        self.min_size = min_size
        self.max_size = max_size
        self.pool: asyncpg.Pool | None = None

    async def open(self) -> None:
        if self.pool is None:
            self.pool = await asyncpg.create_pool(self.url, min_size=self.min_size, max_size=self.max_size)

    async def close(self) -> None:
        if self.pool is not None:
            await self.pool.close()
            self.pool = None

    def require_pool(self) -> asyncpg.Pool:
        if self.pool is None:
            raise RuntimeError("database chưa open")
        return self.pool

    @asynccontextmanager
    async def connection(self) -> AsyncIterator[asyncpg.Connection]:
        async with self.require_pool().acquire() as conn:
            yield conn

    @asynccontextmanager
    async def transaction(self) -> AsyncIterator[asyncpg.Connection]:
        async with self.require_pool().acquire() as conn:
            async with conn.transaction():
                yield conn


async def apply_migrations(db: Database, migrations_dir: Path | None = None) -> list[str]:
    root = Path(__file__).resolve().parents[2]
    configured = os.environ.get("INTERLINK_MIGRATIONS_DIR")
    directory = migrations_dir or (Path(configured) if configured else root / "src" / "db" / "migrations")
    if not directory.is_dir():
        fallback = Path.cwd() / "src" / "db" / "migrations"
        if fallback.is_dir():
            directory = fallback
        else:
            raise FileNotFoundError(f"không tìm thấy migrations directory: {directory}")
    applied: list[str] = []
    async with db.transaction() as conn:
        await conn.execute(
            "CREATE TABLE IF NOT EXISTS schema_migrations "
            "(name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
        )
    async with db.connection() as conn:
        done = {r["name"] for r in await conn.fetch("SELECT name FROM schema_migrations")}
    for path in sorted(directory.glob("*.sql")):
        if path.name in done:
            continue
        sql = path.read_text(encoding="utf-8")
        async with db.transaction() as conn:
            await conn.execute(sql)
            await conn.execute("INSERT INTO schema_migrations(name) VALUES($1)", path.name)
        applied.append(path.name)
    return applied
