import { pathToFileURL } from "node:url";

/** true khi file này đang được chạy trực tiếp (tsx src/x/main.ts hoặc node dist/x.js), không phải được import. */
export function isMain(builtName: string, metaUrl = ""): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const normalized = argv1.split("\\").join("/");
  return normalized.endsWith(`/${builtName}`) || (!!metaUrl && pathToFileURL(argv1).href === metaUrl);
}
