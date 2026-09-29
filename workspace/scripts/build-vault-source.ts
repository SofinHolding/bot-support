/**
 * Bảng rà soát V1 khách trả về (Ra_soat-du-lieu-V1*.xlsx) -> tệp nguồn SẠCH để tải vào "Thêm nội dung" (vault, docs/adr/0005).
 * Không tải thẳng bảng rà soát: 478 dòng so sánh cặp và các sheet hướng dẫn sẽ thành note rác.
 *
 * Làm gì (chỉ code, KHÔNG gọi AI):
 *  - lấy nội dung ở sheet "3. Toàn bộ nội dung V1" (câu trả lời mẫu + đoạn tài liệu);
 *  - bỏ tin hệ thống / hội thoại do code gửi (chống spam, cảnh báo bảo mật, chào lại, cảm ơn…): không phải tri thức;
 *  - áp các quyết định ĐÃ RÕ của khách ở sheet "1. Cần xác nhận" (bảng DECISIONS bên dưới, mỗi dòng ghi lý do);
 *  - quyết định còn mơ hồ: GIỮ NGUYÊN nội dung, ghi vào danh sách cần chốt kèm đề xuất (bất biến 7: không tự suy luận thay khách).
 *
 *   npx tsx scripts/build-vault-source.ts --file="raw-data/Ra_soat-du-lieu-V1- update.xlsx" [--out=.staging/vault-source]
 * Ra: <out>/V1-nguon-sach.xlsx (MỘT sheet, tải lên Admin Web) và <out>/V1-bao-cao.md (đã áp gì, cần chốt gì, dòng nào là mục nào).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import ExcelJS from "exceljs";

const arg = (k: string, d?: string) => process.argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3) ?? d;
const file = arg("file");
const outDir = arg("out", ".staging/vault-source")!;
if (!file) throw new Error('thiếu --file="đường dẫn bảng rà soát .xlsx"');

const text = (v: ExcelJS.CellValue): string => {
  if (v == null) return "";
  if (typeof v === "object" && "richText" in v) return v.richText.map((r) => r.text).join("");
  if (typeof v === "object" && "text" in v) return String(v.text);
  if (typeof v === "object" && "result" in v) return String(v.result ?? "");
  return String(v);
};

interface Item {
  code: string;
  kind: string;
  source: string;
  name: string;
  questions: string;
  content: string;
}

/** Nhóm câu mẫu không phải tri thức: code gửi đúng lúc (bảo mật, chống spam, quá tải...) hoặc câu hội thoại. */
const EXCLUDED_SOURCES = new Set(["Templates: system", "Templates: followup"]);

type Edit = { issue: string; note: string; apply: (items: Map<string, Item>) => void };
type Pending = { issue: string; question: string; proposal: string; codes: string[] };

const replaceIn = (items: Map<string, Item>, code: string, from: string | RegExp, to: string) => {
  const it = items.get(code);
  if (!it) throw new Error(`không thấy ${code} trong sheet 3`);
  const next = it.content.replace(from, to);
  if (next === it.content) throw new Error(`${code}: không tìm thấy đoạn cần sửa (${String(from)}) — nội dung trong bảng rà soát đã khác?`);
  it.content = next;
};

/** Quyết định ĐÃ RÕ: áp thẳng. Mỗi mục trích lại câu khách trả lời để người đọc báo cáo đối chiếu được. */
const DECISIONS: Edit[] = [
  {
    issue: "V005",
    note: 'Khách chọn "báo giờ trả thưởng trước (3 giờ sáng Chủ nhật UTC+0)": bỏ mục "Chưa nhận thưởng tuần (chuyển nhân viên)", câu "weekly reward chưa nhận" chuyển sang mục "Chưa nhận thưởng tuần / tháng" (mục này đã có câu chuyển nhân viên nếu quá giờ).',
    apply: (m) => {
      m.delete("template:esc-weekly-reward");
      const it = m.get("template:weekly-reward-schedule")!;
      it.questions = [it.questions, "weekly reward chưa nhận"].filter(Boolean).join(" | ");
    },
  },
  {
    issue: "V141",
    note: 'Khách: "They both make sense…" — thêm nguyên văn giải thích của khách vào đoạn Whitepaper (10 tỷ là tổng cung ban đầu; phí giao dịch bị đốt vĩnh viễn nên nguồn cung thực tế giảm dần).',
    apply: (m) => {
      const it = m.get("chunk:whitepaper-data#FAQ (from Whitepaper) › Q: Why was ITLG initially said to be 10 billion? Did you increase the supply?")!;
      it.content = `${it.content.replace(/\n-{3,}\s*$/, "").trimEnd()}\n\nThe 10 billion represents the initial total supply stated in the Whitepaper. However, as transactions happen, the transaction fee is permanently burned, which gradually decreases the actual supply over time.`;
    },
  },
  {
    issue: "V310",
    note: 'Khách: "theo dõi trang X để cập nhật" — bỏ câu mốc niêm yết "cuối 2025 hoặc đầu 2026" (đã qua) khỏi đoạn Whitepaper, thay bằng lời mời theo dõi X như câu trả lời mẫu "Niêm yết sàn / TGE". Phần DAO bỏ phiếu và lịch mở khoá TGE giữ nguyên.',
    apply: (m) =>
      replaceIn(
        m,
        "chunk:whitepaper-data#FAQ (from Whitepaper) › Q: When will the token be listed on an exchange? What will the TGE look like?",
        "The current plan is to list the token toward the end of 2025 or early 2026. However, now",
        "There is no confirmed listing date yet. Follow our project on social media to stay updated: https://x.com/inter_link\n\nNow",
      ),
  },
  { issue: "V177", note: 'Khách: "đúng" — giữ cả hai (câu mẫu tạo/tham gia nhóm; đoạn tài liệu so sánh đào nhóm với đào cá nhân). Không đổi nội dung.', apply: () => undefined },
  { issue: "V452", note: 'Khách: "trả lời theo mẫu đã cung cấp trước đây" — giữ câu mẫu "Cách kiếm thêm ITLG" (thưởng mời bạn, game, sự kiện). Không đổi nội dung.', apply: () => undefined },
];

/** Quyết định còn mơ hồ: KHÔNG áp. Ghi câu cần chốt + đề xuất; chốt xong thì chuyển sang DECISIONS và chạy lại. */
const PENDING: Pending[] = [
  {
    issue: "V067, V072, V097, V108, V109, V120",
    question: 'Khách chọn Whitepaper là nguồn đúng (ITL là tài sản dự trữ dùng để staking, ITLG là token tiện ích) nhưng không viết nội dung thay cho các đoạn Infrastructure đang ghi ngược lại. Sửa thế nào?',
    proposal: 'Đoạn "Dual-Token Economy" và câu hỏi "What are the two tokens?" trong Hỏi đáp Infrastructure viết lại theo câu của khách: "$ITL is the reserve asset used for staking; $ITLG is the utility token (the main payment medium in games and mini-apps on InterLink)." Bỏ các chữ "Governance token (voting…)" và "Utility/Payment token (gas fees…)". Hoặc: bỏ hẳn phần vai trò token khỏi Infrastructure, chỉ để Whitepaper trả lời.',
    codes: ["chunk:infrastructure-data#7. INTERLINK TOKENOMICS › Dual-Token Economy", "chunk:infrastructure-data#Q&A — Infrastructure & Credibility"],
  },
  {
    issue: "V002",
    question: 'Khách trả lời bằng câu "Follow our project on social media to stay updated https://x.com/inter_link". Nghĩa là khách hỏi chuyển ITLG sang ITL thì cũng trả lời câu này (bỏ mục "Chuyển ITLG sang ITL"), hay giữ câu "ITLG hasn\'t entered the verification phase yet" cho câu hỏi chuyển đổi và chỉ bỏ "convert ITLG" khỏi mục niêm yết?',
    proposal: 'Giữ hai mục, bỏ "convert ITLG", "convert to ITL" khỏi mục "Niêm yết sàn / TGE" (đúng đề xuất ở sheet 1).',
    codes: ["template:fp-3-listing-tge", "template:itlg-to-itl-conversion"],
  },
  {
    issue: "V027",
    question: 'Khách trả lời "CÓ" cho vế thứ hai (lời khuyên tăng hoạt động áp dụng cả cho người đang chờ curator). Vế thứ nhất chưa trả lời: khách chỉ nói "KYC chậm" thì dùng câu nào?',
    proposal: 'Mục "Chờ lâu chưa được curator chọn" thêm đoạn khuyên tăng hoạt động và video của mục "KYC xét duyệt lâu", để câu "KYC chậm" chung nhận đủ cả hai ý.',
    codes: ["template:fp-6-kyc-slow", "template:fp-6b-kyc-review-long"],
  },
  {
    issue: "V164, V178, V344, V457",
    question: 'Khách: "trả lời theo tài liệu đã cung cấp trước đây… lỗi về ambassador nhắn: Unfortunately, we\'re not part of the ambassador program. Please contact her directly for support: @reina_interlinklabs". (1) Link tham gia dùng link trong tài liệu (t.me/InterLinkCoachHouse) thay link t.me/Interlink_Coach_House_Onboarding/150662? (2) Câu về lỗi Ambassador là một mục MỚI (khách báo lỗi liên quan Ambassador)? (3) Người liên hệ @ekwinbudi trong mục "Muốn làm Ambassador" giữ hay đổi thành @reina_interlinklabs?',
    proposal: "(1) dùng link của tài liệu; (2) thêm mục mới với nguyên văn câu của khách; (3) giữ @ekwinbudi cho câu hỏi tham gia, @reina_interlinklabs cho lỗi.",
    codes: ["template:fp-11-ambassador", "chunk:ambassador-program#Q&A — Ambassador Program", "chunk:ambassador-program#3. How to Become an Ambassador"],
  },
  {
    issue: "V001",
    question: 'Khách: nút chính xác nhất là "Forgot Interlink ID?". Hai mục "Quên ID" (bấm "Forgot ID") và "Quên ID đăng nhập" (bấm "Forgot Login ID" rồi quét mặt) có phải cùng một nút / một quy trình không?',
    proposal: 'Nếu cùng một nút: đổi tên nút ở cả hai mục thành "Forgot Interlink ID?" và gộp thành một mục (quét mặt + video demo). Nếu khác: chỉ đổi tên nút ở mục "Quên ID".',
    codes: ["template:fp-8-forgot-id", "template:forgot-login-id"],
  },
];

async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file!);
  const ws = wb.worksheets.find((w) => w.name.startsWith("3."));
  if (!ws) throw new Error('không có sheet "3. Toàn bộ nội dung V1": đây không phải bảng rà soát V1?');
  const items = new Map<string, Item>();
  const excluded: Item[] = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const v = (row.values as ExcelJS.CellValue[]).slice(1).map(text);
    const it: Item = { code: v[0]!.trim(), kind: v[1]!.trim(), source: v[2]!.trim(), name: v[3]!.trim(), questions: v[4]!.trim(), content: v[5]!.trim() };
    if (!it.code || !it.content) return;
    if (EXCLUDED_SOURCES.has(it.source)) excluded.push(it);
    else items.set(it.code, it);
  });

  // quyết định của khách chưa được đánh "đã xác nhận" trong bảng: báo lại để người dùng biết
  const s1 = wb.worksheets.find((w) => w.name.startsWith("1."));
  const statuses = new Set<string>();
  s1?.eachRow((row, n) => {
    if (n === 1) return;
    const head = (s1.getRow(1).values as ExcelJS.CellValue[]).map(text);
    statuses.add(text(row.getCell(head.indexOf("Review Status")).value));
  });

  const applied: string[] = [];
  for (const d of DECISIONS) {
    d.apply(items);
    applied.push(`- **${d.issue}**: ${d.note}`);
  }

  // tệp tải lên: MỘT sheet, ba cột. Không có mã hệ thống (không phải nội dung trả lời khách); tra ở báo cáo theo số dòng.
  const out = new ExcelJS.Workbook();
  const sheet = out.addWorksheet("Noi dung V1");
  sheet.addRow(["Tên", "Khách thường hỏi", "Nội dung"]);
  const rowMap: string[] = [];
  const ordered = [...items.values()].sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  for (const it of ordered) {
    sheet.addRow([it.name, it.questions, it.content]);
    rowMap.push(`| ${sheet.rowCount} | ${it.name.replace(/\|/g, "/")} | \`${it.code}\` |`);
  }
  mkdirSync(outDir, { recursive: true });
  await out.xlsx.writeFile(join(outDir, "V1-nguon-sach.xlsx"));

  const report = [
    "# Tệp nguồn sạch từ bảng rà soát V1",
    "",
    `Nguồn: \`${file}\`. Trạng thái khách ghi ở sheet 1: ${[...statuses].filter(Boolean).join(", ") || "(trống)"}; cột "Final Resolution" để trống, khách ghi mọi quyết định ở "Human Decision".`,
    "",
    `- Đưa vào tệp sạch: **${ordered.length}** mục (${ordered.filter((i) => i.kind.startsWith("Câu")).length} câu trả lời mẫu, ${ordered.filter((i) => !i.kind.startsWith("Câu")).length} đoạn tài liệu).`,
    `- Bỏ ra (tin hệ thống / hội thoại do code gửi, không phải tri thức): **${excluded.length}** mục — ${excluded.map((i) => i.name).join("; ")}.`,
    "- Sheet 2 (478 cặp \"Không cần xử lý\"): khách không phản đối dòng nào, không cần làm gì.",
    "",
    "## Đã áp (quyết định rõ)",
    "",
    ...applied,
    "",
    "## Cần chốt trước khi nạp (CHƯA áp, nội dung đang giữ nguyên)",
    "",
    ...PENDING.flatMap((p, i) => [`### ${i + 1}. ${p.issue}`, "", `**Cần chốt:** ${p.question}`, "", `**Đề xuất:** ${p.proposal}`, "", `Mục liên quan: ${p.codes.map((c) => items.get(c)?.name ?? c).join("; ")}`, ""]),
    "## Dòng trong tệp sạch ↔ mục trong hệ thống cũ",
    "",
    "| Dòng | Tên | Mã hệ thống |",
    "|---|---|---|",
    ...rowMap,
    "",
  ].join("\n");
  writeFileSync(join(outDir, "V1-bao-cao.md"), report, "utf8");
  console.log(`Đã ghi ${join(outDir, "V1-nguon-sach.xlsx")} (${ordered.length} mục) và ${join(outDir, "V1-bao-cao.md")}; ${applied.length} quyết định đã áp, ${PENDING.length} nhóm cần chốt.`);
}

await main();
