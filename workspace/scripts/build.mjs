import { cpSync, mkdirSync, rmSync } from "node:fs";
import { build } from "esbuild";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });
await build({
  entryPoints: { bot: "src/bot/main.ts", admin: "src/admin/main.ts", worker: "src/worker/main.ts", seed: "src/cli/seed.ts", migrate: "src/db/migrate-cli.ts", eval: "src/cli/eval.ts" },
  outdir: "dist",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  packages: "external", // dependencies nằm trong node_modules
  sourcemap: true,
  logLevel: "info",
});
cpSync("src/db/migrations", "dist/migrations", { recursive: true });
cpSync("src/admin/web", "dist/web", { recursive: true });
console.log("Build xong: dist/{bot,admin,worker,seed,migrate,eval}.js");
