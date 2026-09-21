import { loadConfig } from "../config";
import { migrate, openDb } from "./db";

const cfg = loadConfig();
const db = await openDb(cfg.DATABASE_URL);
const applied = await migrate(db);
console.log(applied.length ? `Đã áp dụng: ${applied.join(", ")}` : "Schema đã ở phiên bản mới nhất.");
await db.close();
