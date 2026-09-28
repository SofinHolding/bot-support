/**
 * File thông báo xung đột trong `_notifications/` (mẫu assets/notification-template.md của skill), thêm trường có cấu trúc
 * `conflict_id` + danh sách ứng viên để cơ chế gửi (Admin Web, Telegram) tra lại bảng ingest_conflicts. File chỉ mô tả, không gửi.
 */
import { stringify as stringifyYaml } from "yaml";
import type { ConflictCandidate, ConflictType } from "../db/repo-vault";

export const TYPE_LABEL: Record<ConflictType, string> = {
  in_file: "Xung đột ngay trong file vừa nạp",
  tie: "Xung đột với bản cũ, cùng mốc thời gian",
  version: "Xung đột giữa phiên bản cũ và mới",
};

export const notificationFileName = (date: string, versionGroup: string) => `_notifications/${date}_${versionGroup}_chan.md`;

export function renderNotification(c: {
  id: number;
  type: ConflictType;
  versionGroup: string;
  topic: string;
  createdAt: string;
  sourceFile: string;
  candidates: ConflictCandidate[];
  reasons: string[];
}): string {
  const front = stringifyYaml(
    {
      notification_id: `${c.createdAt.slice(0, 10)}_${c.versionGroup}_chan`,
      conflict_id: c.id,
      created_at: c.createdAt,
      priority: "chan",
      conflict_type: c.type === "in_file" ? "noi-bo" : "phien-ban",
      version_group: c.versionGroup,
      candidates: c.candidates.map((x) => ({ label: x.label, note_id: x.noteId, old: !!x.old })),
      status: "cho-duyet",
    },
    { lineWidth: 0 },
  ).trimEnd();
  const quote = (s: string) => s.split(/\r?\n/).map((l) => `> ${l}`).join("\n");
  const options = c.candidates.map((x) => (x.old ? `### Bản cũ đang dùng — ${x.title}` : `### Phương án ${x.label} — ${x.title}`) + `\nNguồn: ${x.sourceFile}${x.sourceRefs.length ? ` (${x.sourceRefs.join("; ")})` : ""}, nạp lúc ${x.ingestedAt}\n\n${quote(x.excerpt)}`).join("\n\n");
  const hasOld = c.candidates.some((x) => x.old);
  const keep = c.candidates.filter((x) => !x.old).map((x) => `- [ ] Giữ phương án ${x.label}`);
  return `---\n${front}\n---\n\n# ⚠️ Cần xác nhận: ${c.topic}\n\n**Mức ưu tiên:** Chặn — dữ liệu mới CHƯA được dùng để trả lời khách${hasOld ? " (khách vẫn nhận bản cũ)" : ""}\n\n**Loại xung đột:** ${TYPE_LABEL[c.type]}\n\n**Nguồn:** ${c.sourceFile}\n\n${c.reasons.length ? `**Khác nhau ở đâu:**\n${c.reasons.map((r) => `- ${r}`).join("\n")}\n\n` : ""}## Nội dung đang mâu thuẫn\n\n${options}\n\n## Cần người duyệt trả lời\n\n${[...keep, ...(hasOld ? ["- [ ] Giữ bản cũ"] : []), "- [ ] Gộp / nhập lại (ghi rõ nội dung đúng)", "- [ ] Bỏ các phương án mới"].join("\n")}\n\n---\n*Chọn trên Admin Web (mục Xung đột dữ liệu) hoặc nút trong tin Telegram. File này chỉ mô tả nội dung cần duyệt.*\n`;
}
