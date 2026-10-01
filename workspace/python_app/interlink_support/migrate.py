from __future__ import annotations

import asyncio

from .config import get_settings
from .db import Database, apply_migrations


async def _run() -> None:
    settings = get_settings()
    db = Database(settings.DATABASE_URL)
    await db.open()
    try:
        applied = await apply_migrations(db)
        print("Applied: " + ", ".join(applied) if applied else "Schema is up to date.")
    finally:
        await db.close()


def main() -> None:
    asyncio.run(_run())


if __name__ == "__main__":
    main()
