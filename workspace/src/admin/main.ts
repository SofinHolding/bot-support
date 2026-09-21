import { isMain } from "../entry";
import { createServices } from "../app";
import { loadConfig } from "../config";
import { buildAdminServer } from "./server";

if (isMain("admin.js", import.meta.url)) {
  const cfg = loadConfig();
  const svc = await createServices(cfg, "admin");
  const app = await buildAdminServer(svc);
  await app.listen({ port: cfg.ADMIN_PORT, host: "0.0.0.0" });
  svc.log("info", `admin lắng nghe :${cfg.ADMIN_PORT}`);
  const shutdown = async () => {
    await app.close();
    await svc.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
