/**
 * Hợp nhất các template trùng (theo báo cáo scripts/list-template-conflicts.ts) — CHỈ TẠO BẢN ĐỀ XUẤT, không publish, không
 * sửa DB. Đọc template ĐANG PUBLISH thật từ DB, áp dụng danh sách gộp bên dưới, rồi xuất:
 *   1. <out>/NOI-DUNG-THEO-CHU-DE.md — bản để người đọc: xếp theo chủ đề, mỗi câu trả lời viết ĐẦY ĐỦ (không trỏ answer_from).
 *   2. <out>/templates/<slug>.md    — bản cho hệ thống (đúng định dạng đang dùng, giữ answer_from vì code dựa vào nó để nhận
 *                                     biết template chuyển nhân viên), để publish SAU KHI người dùng duyệt.
 *   3. So sánh bộ câu kiểm tra (eval_cases) trước/sau gộp, cùng router tầng 0-1 và cùng model embedding.
 *
 *   EMBEDDING_URL=http://localhost:8081/v1 DATABASE_URL=... npx tsx scripts/consolidate-templates.ts [--out=.staging/hop-nhat]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../src/config";
import { embedTagged, type Embedder } from "../src/core/embedding";
import { TemplateIndex } from "../src/core/template-index";
import { templatesToMarkdown, validateBundle } from "../src/core/templates";
import { openDb } from "../src/db/db";
import { kbRepo } from "../src/db/repo-kb";
import { opsRepo } from "../src/db/repo-ops";
import type { Template } from "../src/domain/types";
import { evalSettings, runEval, type EvalCase } from "../src/kb/eval";
import { LiveContent } from "../src/kb/live-content";
import { EmbeddingConfig } from "../src/llm/embedding-config";
import { createEmbedder, SelectedEmbedder } from "../src/llm/embedder";
import { SecretBox } from "../src/llm/secret-box";
import { TEMPLATE_TITLES as TITLES } from "./lib/template-titles";

const outDir = process.argv.find((a) => a.startsWith("--out="))?.slice(6) ?? ".staging/hop-nhat";

// ---------------------------------------------------------------- Danh sách gộp (mỗi mục = một quyết định người dùng duyệt)
interface Merge {
  keep: string; // id giữ lại
  drop: string; // id bị gộp vào `keep` rồi bỏ
  why: string;
  answerEn: (keep: Template, drop: Template) => string;
  priority?: (keep: Template, drop: Template) => number;
  /** Bỏ `excludes` của `keep` (chỉ tồn tại để tách hai template này khỏi nhau). */
  clearExcludes?: boolean;
  /** Việc người dùng cần xác nhận vì hai bên nói KHÁC nhau. */
  confirm?: string;
}

const MERGES: Merge[] = [
  {
    keep: "forgot-login-id",
    drop: "fp-8-forgot-id",
    why: "Cùng tình huống: khách quên ID đăng nhập. Giữ câu trả lời cụ thể hơn (quét mặt + cách xử lý khi không được) và thêm video demo của bên kia.",
    answerEn: (k, d) => `${k.answers.en!.split("\n\n")[0]}\n📹 Demo: ${/https:\/\/\S+/.exec(d.answers.en!)![0]}\n\n${k.answers.en!.split("\n\n").slice(1).join("\n\n")}`,
    priority: (k, d) => Math.max(k.priority, d.priority),
    clearExcludes: true,
    confirm: 'Hai bản cũ ghi tên nút khác nhau: "Forgot ID" (fp-8-forgot-id) và "Forgot Login ID" (forgot-login-id), và cấu hình cũ có ghi chú cố ý tách hai trường hợp này. Bản gộp dùng "Forgot Login ID" (bản cụ thể hơn). Nếu app THẬT SỰ có hai nút khác nhau thì KHÔNG nên gộp cặp này — báo lại để giữ nguyên hai mục.',
  },
  {
    keep: "fp-4-itlg-burn",
    drop: "itlg-burn-despite-mining",
    why: "Cùng câu hỏi \"tại sao ITLG bị trừ/burn\". Gộp giải thích chung với số liệu cụ thể (1000/500 ITLG, không bị trừ lần hai).",
    answerEn: (k, d) => {
      const [intro, rule, ...media] = k.answers.en!.split("\n");
      return [intro, rule, "", d.answers.en!.trim(), "", ...media].join("\n");
    },
  },
  {
    keep: "weekly-reward-schedule",
    drop: "esc-weekly-reward",
    why: "Cùng tình huống: chưa nhận thưởng tuần. esc-weekly-reward chỉ có câu chuyển nhân viên chung; weekly-reward-schedule nói rõ giờ trả thưởng và khi nào mới liên hệ hỗ trợ.",
    answerEn: (k) => k.answers.en!,
    confirm: 'Trước đây khách nhắn "weekly reward chưa nhận" được chuyển nhân viên NGAY. Sau khi gộp, bot gửi giờ trả thưởng trước; nếu khách vẫn báo chưa nhận thì mới chuyển nhân viên (vẫn tạo ticket M03 cho Minh).',
  },
  {
    keep: "fp-3-listing-tge",
    drop: "itlg-to-itl-conversion",
    why: 'fp-3-listing-tge đang giữ từ khoá "convert ITLG", "convert to ITL" nên câu hỏi chuyển đổi luôn rơi vào nó, itlg-to-itl-conversion gần như không bao giờ được dùng. Gộp hai câu trả lời (không mâu thuẫn nhau).',
    answerEn: (k, d) => `${d.answers.en!.trim()}\n${k.answers.en!.trim()}`,
    confirm: 'Câu hỏi về niêm yết/TGE giờ cũng nhận câu "ITLG hasn\'t entered the verification phase yet". Xác nhận câu này đúng cho cả câu hỏi niêm yết.',
  },
];

/** Các cặp điểm cao trong báo cáo xung đột nhưng KHÔNG gộp: giống chữ, khác tình huống của khách (gộp sẽ trả lời sai một bên). */
const KEPT: [string, string, string][] = [
  ["esc-forgot-password", "forgot-login-id", "quên mật khẩu (cần nhân viên reset) khác quên ID (tự lấy lại bằng quét mặt)"],
  ["esc-login-fail", "forgot-login-id", "đăng nhập / quét mặt bị lỗi khác quên ID"],
  ["esc-swap", "wallet-swap-token-missing", "swap bị lỗi / bị kẹt (chuyển nhân viên) khác swap xong nhưng token chưa hiện (tự bật token trong ví)"],
  ["fp-4-itlg-burn", "itlg-mining-reduced-50", "số dư bị trừ do burn khác tốc độ khai thác giảm 50% do DAO"],
  ["fp-4-itlg-burn", "itlg-recover-after-burn", "vì sao bị trừ khác cách lấy lại"],
  ["esc-mining-bug", "fp-4-itlg-burn", "lỗi khai thác không cộng ITLG (chuyển nhân viên) khác bị trừ do burn"],
  ["esc-token-missing", "itlg-recover-after-burn", "token / faucet chưa về khác lấy lại ITLG đã burn"],
  ["fp-3-listing-tge", "itlg-earn-more", "niêm yết khác cách kiếm thêm ITLG"],
  ["fp-6-kyc-slow", "kyc-matched-not-verified", "chưa được curator chọn khác đã được chọn nhưng chưa có thông báo"],
  ["fp-6b-kyc-review-long", "fp-6-kyc-slow", "đang xét duyệt lâu / đã xong bước 1 khác còn chờ được chọn (đã tách bằng điều kiện)"],
  ["esc-wallet-create", "wallet-create", "tạo ví bị lỗi (chuyển nhân viên) khác hỏi cách tạo ví"],
  ["esc-wallet-create", "wallet-reset-lost", "tạo ví bị lỗi khác mất ví sau khi xoá app"],
  ["otp-email", "otp-telegram", "hai kênh nhận OTP khác nhau, cách xử lý khác nhau"],
  ["esc-hcs-app", "hcs-low", "HCS không cộng / không tăng (chuyển nhân viên) khác HCS thấp so với người khác"],
  ["hcs-multiple-wallets", "hcs-wallet-not-added", "hỏi quy định liên kết nhiều ví khác HCS ở ví chưa được cộng"],
  ["how-to-login", "how-to-sign-up", "đăng nhập khác đăng ký"],
];

// ---------------------------------------------------------------- Điều kiện khớp, viết lại bằng lời thường
const PRED_VI: Record<string, string> = {
  mentions_forgot: "nói quên", mentions_login_id: "nhắc tới Login ID", mentions_kyc_email_received: "đã nhận email xác minh",
  still_waiting: "app vẫn đang chờ", mentions_kyc: "nhắc tới KYC", mentions_duration: "nói thời gian chờ (vd 20 ngày)",
  mentions_duration_with_kyc: "nói thời gian chờ KYC", mentions_campaign_10m: "nhắc Campaign 10M", nft_not_received: "chưa nhận NFT",
  completed_level_1: "đã xong level 1", wants_speed_up: "muốn đẩy nhanh",
};
const condVi = (c: unknown): string =>
  typeof c === "string"
    ? PRED_VI[c] ?? c
    : c && typeof c === "object" && "any" in c
      ? `có một trong: ${(c as { any: string[] }).any.map((x) => `"${x}"`).join(", ")}`
      : JSON.stringify(c);

// ---------------------------------------------------------------- Chủ đề hiển thị cho người đọc
const TOPICS: { name: string; ids: string[]; locked?: boolean }[] = [
  { name: "Chào hỏi và phản hồi chung", ids: ["fp-1-greeting", "greeting-returning", "you-are-welcome"] },
  { name: "Tài khoản và đăng nhập", ids: ["how-to-sign-up", "how-to-login", "forgot-login-id", "esc-forgot-password", "esc-login-fail", "face-scan-black-screen", "otp-email", "otp-telegram", "fp-7-change-email", "email-old-email-required", "fp-10-change-id", "fp-9-delete-account", "twin-account", "referral-code"] },
  { name: "KYC (xác minh danh tính)", ids: ["fp-5-how-to-kyc", "fp-5b-kyc-email-queue", "fp-6-kyc-slow", "fp-6b-kyc-review-long", "kyc-matched-not-verified"] },
  { name: "ITLG: khai thác, burn, rút tiền, niêm yết", ids: ["fp-2-withdraw", "fp-3-listing-tge", "fp-4-itlg-burn", "itlg-recover-after-burn", "itlg-mining-reduced-50", "itlg-earn-more", "esc-mining-bug", "esc-token-missing"] },
  { name: "Ví (wallet)", ids: ["wallet-create", "esc-wallet-create", "wallet-reset-lost", "wallet-check-seedphrase", "wallet-address", "wallet-connect-social", "wallet-visa-card", "wallet-swap-token-missing", "esc-swap"] },
  { name: "HCS", ids: ["hcs-formula", "hcs-low", "hcs-wallet-not-added", "hcs-multiple-wallets", "esc-hcs-app"] },
  { name: "Game và thưởng", ids: ["game-slime-cloud", "game-upgrade-max", "weekly-reward-schedule", "esc-game-bug"] },
  { name: "Group Mining", ids: ["group-mining-create"] },
  { name: "Ambassador và Campaign", ids: ["fp-11-ambassador", "fp-11b-campaign-10m-nft"] },
  { name: "Giới thiệu dự án", ids: ["whitepaper-general"] },
  { name: "Chuyển nhân viên hỗ trợ", ids: ["fp-12-escalate", "esc-app-error-image"] },
  { name: "Tin nhắn hệ thống (🔒 do code gửi, không sửa ở đây)", ids: ["fp-0-security-alert", "fp-0-owner-notice", "antispam-1", "antispam-2", "antispam-3", "antispam-4", "antispam-5", "antispam-6", "antispam-7plus", "high-traffic", "image-unreadable", "image-cover-secret", "admin-console-moved"], locked: true },
];

// ---------------------------------------------------------------- Hiển thị cho người đọc
const IMAGE_VI: Record<string, string> = { error_dialog: "ảnh chụp hộp thoại báo lỗi", kyc_email: "ảnh email KYC", kyc_queue_screen: "ảnh màn hình chờ KYC" };
const FOLLOW_VI: Record<string, string> = { negative: "khách nói vẫn chưa được", not_receive: "khách nói vẫn không nhận được", info_provided: "khách gửi thông tin đã xin", more_images: "khách gửi thêm ảnh", thanks: "khách cảm ơn", no_old_email: "khách không còn email cũ" };
const dedupe = (xs: string[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = x.trim().toLowerCase();
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};
const quote = (s: string) => s.trim().split("\n").map((l) => `> ${l}`).join("\n");

function renderReadable(t: Template, byId: Map<string, Template>, mergedFrom: Map<string, Merge>): string {
  const src = t.answer_from ? byId.get(t.answer_from) : undefined;
  const answer = (src ?? t).answers.en ?? "";
  const asks = dedupe([...t.match.exact, ...t.match.keywords, ...t.match.examples]);
  const out: string[] = [];
  const title = TITLES[t.id] ?? t.sets_context.issue ?? t.id;
  out.push(`### ${title}`);
  out.push("");
  out.push(`<sub>mã: \`${t.id}\`</sub>`);
  const m = mergedFrom.get(t.id);
  if (m) out.push("", `**Đã gộp vào mục này:** mục cũ \`${m.drop}\`. ${m.why}`);
  out.push("");
  if (asks.length) out.push(`**Khách thường hỏi:** ${asks.map((a) => `"${a}"`).join(" · ")}`, "");
  if (t.match.rules.length) out.push(`**Hoặc khi tin nhắn có đủ các ý:** ${t.match.rules.map((r) => r.all.map(condVi).join(" + ")).join("; hoặc ")}`, "");
  if (t.match.image_types.length) out.push(`**Hoặc khi khách gửi:** ${t.match.image_types.map((i) => IMAGE_VI[i] ?? i).join(", ")}`, "");
  if (t.match.excludes.length) out.push(`**Không dùng khi tin nhắn:** ${t.match.excludes.map(condVi).join("; ")}`, "");
  if (!asks.length && !t.match.rules.length && !t.match.image_types.length) out.push("**Khi nào gửi:** do hệ thống tự gửi đúng lúc (không khớp theo câu hỏi).", "");
  out.push("**Bot trả lời:**", "", quote(answer.replace("{SUPPORT_SUMMARY}", "")));
  if (t.answer_from === "fp-12-escalate") out.push("", "_(Kèm theo là khối tóm tắt vụ việc để khách gửi cho nhân viên.)_");
  const follow = Object.entries(t.follow_up);
  if (follow.length) {
    out.push("", "**Sau đó:**");
    for (const [k, v] of follow) out.push(`- Nếu ${FOLLOW_VI[k] ?? k} → ${v === "ESCALATE" ? "chuyển nhân viên" : `gửi "${TITLES[v] ?? v}"`}`);
  }
  if (t.ticket || t.required_info?.length) {
    const tk = t.ticket;
    out.push("", `**Ticket cho nhân viên:** ${[tk?.category && `danh mục ${tk.category}`, tk?.error_code && `mã lỗi ${tk.error_code}`, tk?.pic && `người phụ trách ${tk.pic}`].filter(Boolean).join(", ") || "có"}`);
    if (t.required_info?.length) out.push("", `**Cần xin khách:** ${t.required_info.join(", ")}`);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- main
async function main() {
  const cfg = loadConfig();
  const db = await openDb(cfg.DATABASE_URL);
  const kb = kbRepo(db);
  const ops = opsRepo(db);
  const secretBox = cfg.SECRETS_KEY ? new SecretBox(cfg.SECRETS_KEY) : null;
  const embedding = new EmbeddingConfig(ops, secretBox);
  const embedder: Embedder = new SelectedEmbedder(() => embedding.selection(), createEmbedder(cfg), { log: () => undefined, onExternalFailure: async () => undefined });
  const live = new LiveContent(db, kb, ops, embedder, `${cfg.CONTENT_DIR}/config/predicates.yml`, Date.now, async () => (await (embedder as SelectedEmbedder).active()).version);
  await live.rebuild();

  const rows = await kb.loadPublishedTemplateRows();
  const docOf = new Map(rows.map((r) => [r.template.id, r.docSlug]));
  const before = rows.map((r) => r.template);
  const byIdBefore = new Map(before.map((t) => [t.id, t]));

  // áp dụng gộp
  const after = before.map((t) => structuredClone(t));
  const byId = new Map(after.map((t) => [t.id, t]));
  const mergedFrom = new Map<string, Merge>();
  const remap = new Map<string, string>();
  for (const m of MERGES) {
    const k = byId.get(m.keep);
    const d = byIdBefore.get(m.drop);
    if (!k || !d) throw new Error(`thiếu template khi gộp: ${m.keep} / ${m.drop}`);
    k.answers = { ...k.answers, en: m.answerEn(byIdBefore.get(m.keep)!, d) };
    k.match.keywords = dedupe([...k.match.keywords, ...d.match.keywords]);
    k.match.examples = dedupe([...k.match.examples, ...d.match.examples]);
    k.match.exact = dedupe([...k.match.exact, ...d.match.exact]);
    if (m.clearExcludes) k.match.excludes = [];
    if (m.priority) k.priority = m.priority(byIdBefore.get(m.keep)!, d);
    k.required_info = dedupe([...(k.required_info ?? []), ...(d.required_info ?? [])]);
    if (!k.required_info.length) delete k.required_info;
    mergedFrom.set(m.keep, m);
    remap.set(m.drop, m.keep);
    byId.delete(m.drop);
  }
  const merged = after.filter((t) => byId.has(t.id));

  // kiểm tra: bộ mới hợp lệ, mọi template đều có chủ đề
  const issues = validateBundle(merged, live.evaluator.names()).filter((i) => i.level === "error");
  if (issues.length) throw new Error("bộ gộp không hợp lệ: " + issues.map((i) => i.message).join("; "));
  const topicIds = new Set(TOPICS.flatMap((x) => x.ids));
  const missing = merged.filter((t) => !topicIds.has(t.id)).map((t) => t.id);
  const extra = [...topicIds].filter((id) => !byId.has(id));
  if (missing.length || extra.length) throw new Error(`danh sách chủ đề lệch: thiếu ${missing.join(",")} · thừa ${extra.join(",")}`);
  const untitled = merged.filter((t) => !TITLES[t.id]).map((t) => t.id);
  if (untitled.length) throw new Error(`thiếu tên hiển thị: ${untitled.join(",")}`);

  mkdirSync(join(outDir, "templates"), { recursive: true });

  // 1. bản để đọc
  const doc: string[] = [];
  doc.push("# Nội dung trả lời của bot — theo chủ đề", "");
  doc.push(`Bản đề xuất sau khi gộp các mục trùng: **${before.length} → ${merged.length} câu trả lời**. Chưa áp dụng vào bot — chờ bạn duyệt.`, "");
  doc.push("Mỗi mục ghi đủ: khách hay hỏi thế nào, bot trả lời nguyên văn gì, sau đó làm gì, có tạo ticket cho nhân viên không. Câu trả lời để tiếng Anh vì đó là bản gốc bot gửi (bot tự dịch sang ngôn ngữ của khách).", "");
  doc.push("## Cần bạn xác nhận trước khi áp dụng", "");
  for (const m of MERGES.filter((x) => x.confirm)) doc.push(`- **${TITLES[m.keep]}** (gộp \`${m.drop}\` vào \`${m.keep}\`): ${m.confirm}`);
  doc.push("", "## Các cặp giống chữ nhưng KHÔNG gộp", "");
  doc.push("Báo cáo xung đột có nhiều cặp điểm cao vì cùng nói về một chủ đề. Các cặp dưới đây là hai tình huống khác nhau của khách — gộp lại thì một bên sẽ nhận câu trả lời sai, nên giữ riêng.", "");
  doc.push("| Mục | Mục | Vì sao khác |", "|---|---|---|");
  for (const [a, b, why] of KEPT) doc.push(`| ${TITLES[a]} | ${TITLES[b]} | ${why} |`);
  doc.push("", "## Mục lục", "");
  TOPICS.forEach((tp, i) => doc.push(`${i + 1}. ${tp.name} (${tp.ids.length})`));
  for (const tp of TOPICS) {
    doc.push("", "---", "", `## ${tp.name}`, "");
    if (tp.locked) doc.push("_Các tin này do code gửi đúng lúc (cảnh báo bảo mật, chống spam, hệ thống quá tải...). Giữ nguyên, không gộp, không sửa._", "");
    for (const id of tp.ids) doc.push(renderReadable(byId.get(id)!, byId, mergedFrom), "");
  }
  writeFileSync(join(outDir, "NOI-DUNG-THEO-CHU-DE.md"), doc.join("\n"), "utf8");

  // 2. bản cho hệ thống: giữ đúng tài liệu (slug) đang chứa từng template -> publish được thành phiên bản mới của tài liệu cũ
  const bySlug = new Map<string, Template[]>();
  for (const t of merged) bySlug.set(docOf.get(t.id)!, [...(bySlug.get(docOf.get(t.id)!) ?? []), t]);
  const changedSlugs = new Set<string>();
  for (const m of MERGES) {
    changedSlugs.add(docOf.get(m.keep)!);
    changedSlugs.add(docOf.get(m.drop)!);
  }
  for (const slug of changedSlugs) writeFileSync(join(outDir, "templates", `${slug}.md`), templatesToMarkdown(bySlug.get(slug) ?? []), "utf8");

  // 3. đo tác động trên bộ câu kiểm tra: cùng router tầng 0-1, cùng model embedding
  const model = live.index.vectorsModel!;
  const vectorsFor = async (ts: Template[]) => {
    const texts = [...new Set(ts.filter((t) => t.response_mode === "EXACT_TEMPLATE").flatMap((t) => t.match.examples))];
    const r = await embedTagged(embedder, texts);
    if (r.model !== model) throw new Error(`model embedding đổi giữa chừng: ${r.model} ≠ ${model}`);
    const vec = new Map(texts.map((x, i) => [x, r.vectors[i]!]));
    return new Map(ts.map((t) => [t.id, t.match.examples.map((e) => vec.get(e)!).filter(Boolean)]));
  };
  const idxBefore = new TemplateIndex(before, live.evaluator, embedder, await vectorsFor(before), model);
  const idxAfter = new TemplateIndex(merged, live.evaluator, embedder, await vectorsFor(merged), model);
  const cases: EvalCase[] = await kb.listEvalCases();
  const casesAfter = cases.map((c) => ({ ...c, expected_template_id: c.expected_template_id ? remap.get(c.expected_template_id) ?? c.expected_template_id : null }));
  const settings = evalSettings(live.urlHosts);
  const rb = await runEval(cases, idxBefore, live.evaluator, settings);
  const ra = await runEval(casesAfter, idxAfter, live.evaluator, settings);
  const lines: string[] = [`Câu kiểm tra: trước gộp ${rb.correct}/${rb.total} đúng · sau gộp ${ra.correct}/${ra.total} đúng (model ${model}, tầng 0-1 không AI)`];
  rb.rows.forEach((b, i) => {
    const a = ra.rows[i]!;
    if (b.ok !== a.ok) lines.push(`  ${a.ok ? "✔ sửa được" : "✗ hỏng"}: "${b.question}" — mong đợi ${a.expected}; trước: ${b.got}; sau: ${a.got}`);
  });
  writeFileSync(join(outDir, "KET-QUA-KIEM-TRA.txt"), lines.join("\n") + "\n", "utf8");
  console.log(lines.join("\n"));
  console.log(`\nĐã ghi ${outDir}/NOI-DUNG-THEO-CHU-DE.md và ${changedSlugs.size} file template trong ${outDir}/templates/`);
  await db.close();
}
main().catch((e) => {
  console.error("lỗi:", e);
  process.exit(1);
});
