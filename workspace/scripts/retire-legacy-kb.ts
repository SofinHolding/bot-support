/**
 * Xoá hẳn (KHÔNG khôi phục được) các tài liệu KB cũ (kind templates/knowledge) đã publish mà TOÀN BỘ nội dung của chúng đã
 * có bản thay thế `confirmed` trong vault (docs/adr/0005). Dùng đúng `KbService.deleteDocument` (cascade version/chunk/
 * template, audit, bump kb_version để các tiến trình khác — bot, worker — tự nạp lại).
 *
 * KHÔNG xoá:
 *  - `agent-guide` (không xoá được, KbService tự chặn);
 *  - tài liệu template hệ thống/hội thoại (`templates-system`, `templates-followup`): không đi qua vault, bot vẫn cần;
 *  - tài liệu còn MỤC ĐANG CHỜ DUYỆT trong vault (`awaiting_approval`) hoặc mục KHÔNG có note vault tương ứng: xoá ngay sẽ
 *    làm bot mất câu trả lời cho tới khi admin xử lý xong xung đột — chỉ xoá sau khi vault-decide xác nhận.
 *
 *   npx tsx --env-file-if-exists=.env --env-file-if-exists=.env.local scripts/retire-legacy-kb.ts --slug=templates-wallet [--slug=... lặp lại] [--yes]
 */
import { createServices } from "../src/app";
import { loadConfig } from "../src/config";
import type { Actor } from "../src/kb/service";

const slugs = process.argv.filter((a) => a.startsWith("--slug=")).map((a) => a.slice("--slug=".length));
const confirmed = process.argv.includes("--yes");
if (!slugs.length) throw new Error("thiếu --slug=<slug> (lặp lại cho nhiều tài liệu)");
if (!confirmed) throw new Error("thao tác XOÁ HẲN, không khôi phục được — thêm --yes để xác nhận sau khi đã kiểm lại danh sách");

const cfg = loadConfig();
const svc = await createServices(cfg, "admin", { seed: false });
try {
  const actor: Actor = { id: 0, role: "owner", label: "cli:retire-legacy-kb" };
  for (const slug of slugs) {
    const doc = await svc.kb.getDocument(slug);
    if (!doc) {
      console.log(`- ${slug}: không có (đã xoá trước đó?), bỏ qua`);
      continue;
    }
    await svc.kbService.deleteDocument(slug, actor);
    console.log(`- ${slug} [${doc.kind}]: đã xoá`);
  }
  console.log(`kb_version hiện tại: ${await svc.ops.kbVersion()}`);
} finally {
  await svc.close();
}
