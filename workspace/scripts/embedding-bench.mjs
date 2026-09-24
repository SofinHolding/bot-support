/**
 * Đo chất lượng một embedding model trên câu hỏi đa ngôn ngữ (12 ngôn ngữ x 14 template) so với câu hỏi mẫu của template.
 * Dùng khi đổi EMBEDDING_MODEL: chạy trước khi kích hoạt và hiệu chỉnh lại ngưỡng router.semantic_* theo bảng in ra.
 *   node scripts/embedding-bench.mjs --url=http://localhost:8081/v1 --model=bge-m3
 *   API ngoài cần khoá: EMBEDDING_BENCH_KEY=sk-... node scripts/embedding-bench.mjs --url=https://platform.beeknoee.com/v1 --model=gemini-embedding-001 [--query-prefix="Instruct: ...
Query: "]
 * Chạy từ thư mục workspace/ (đọc content/templates). Không tốn token LLM.
 */
import fs from "node:fs";
import yaml from "yaml";

const Q = {
  "fp-2-withdraw": {
    en: "how can I take my tokens out to my own wallet", vi: "làm sao để chuyển token ra ví riêng của mình", zh: "我怎么把代币提到自己的钱包", ko: "토큰을 내 지갑으로 출금하려면 어떻게 하나요", ja: "トークンを自分のウォレットに引き出すにはどうすればいいですか", ru: "как вывести токены на мой кошелёк", ar: "كيف أسحب عملاتي إلى محفظتي", es: "¿cómo puedo retirar mis tokens a mi billetera?", id: "bagaimana cara menarik token ke dompet saya", tr: "tokenlarımı cüzdanıma nasıl çekebilirim", de: "wie kann ich meine Token auszahlen", th: "จะถอนโทเคนออกไปยังกระเป๋าของฉันได้อย่างไร",
  },
  "fp-3-listing-tge": {
    en: "is there a date when the coin gets listed on an exchange", vi: "khi nào coin được niêm yết lên sàn giao dịch", zh: "代币什么时候上交易所", ko: "코인은 언제 거래소에 상장되나요", ja: "コインはいつ取引所に上場しますか", ru: "когда монету добавят на биржу", ar: "متى سيتم إدراج العملة في البورصة", es: "¿cuándo se lista la moneda en un exchange?", id: "kapan koin ini listing di bursa", tr: "coin borsaya ne zaman listelenecek", de: "wann wird der Coin an der Börse gelistet", th: "เหรียญจะเข้าตลาดซื้อขายเมื่อไหร่",
  },
  "fp-4-itlg-burn": {
    en: "my ITLG balance suddenly went down, what happened", vi: "số dư ITLG của mình tự nhiên bị giảm, chuyện gì vậy", zh: "我的ITLG余额突然减少了，怎么回事", ko: "내 ITLG 잔액이 갑자기 줄었어요 왜 그런가요", ja: "ITLGの残高が急に減ったのはなぜですか", ru: "мой баланс ITLG внезапно уменьшился, почему", ar: "رصيد ITLG الخاص بي انخفض فجأة لماذا", es: "mi saldo de ITLG bajó de repente, ¿por qué?", id: "saldo ITLG saya tiba-tiba berkurang kenapa", tr: "ITLG bakiyem aniden azaldı neden", de: "mein ITLG Guthaben ist plötzlich gesunken warum", th: "ยอด ITLG ของฉันลดลงกะทันหัน เพราะอะไร",
  },
  "fp-5-how-to-kyc": {
    en: "what are the steps to get my identity verified", vi: "các bước để xác minh danh tính là gì", zh: "怎么完成实名认证", ko: "본인 인증은 어떻게 진행하나요", ja: "本人確認の手順を教えてください", ru: "как пройти верификацию личности", ar: "كيف أقوم بالتحقق من هويتي", es: "¿cómo verifico mi identidad?", id: "bagaimana cara verifikasi identitas saya", tr: "kimlik doğrulamasını nasıl yapabilirim", de: "wie läuft die Identitätsprüfung ab", th: "ยืนยันตัวตนต้องทำอย่างไร",
  },
  "fp-7-change-email": {
    en: "I need to update the email address on my account", vi: "mình muốn thay địa chỉ email của tài khoản", zh: "我想更换账号绑定的邮箱", ko: "계정에 등록된 이메일을 바꾸고 싶어요", ja: "アカウントのメールアドレスを変更したいです", ru: "я хочу изменить почту, привязанную к аккаунту", ar: "أريد تغيير البريد الإلكتروني المرتبط بحسابي", es: "quiero cambiar el correo electrónico de mi cuenta", id: "saya ingin mengganti email akun saya", tr: "hesabımın e-posta adresini değiştirmek istiyorum", de: "ich möchte die E-Mail-Adresse meines Kontos ändern", th: "ฉันอยากเปลี่ยนอีเมลของบัญชี",
  },
  "fp-9-delete-account": {
    en: "please erase my account permanently", vi: "cho mình xin xoá vĩnh viễn tài khoản", zh: "请永久删除我的账号", ko: "제 계정을 영구적으로 삭제해 주세요", ja: "アカウントを完全に削除してください", ru: "пожалуйста, удалите мой аккаунт навсегда", ar: "أرجو حذف حسابي نهائيا", es: "quiero eliminar mi cuenta para siempre", id: "tolong hapus akun saya secara permanen", tr: "hesabımı kalıcı olarak silin lütfen", de: "bitte löscht mein Konto dauerhaft", th: "ช่วยลบบัญชีของฉันถาวรหน่อย",
  },
  "how-to-login": {
    en: "how do I sign in to the app", vi: "làm thế nào để đăng nhập vào ứng dụng", zh: "怎么登录这个应用", ko: "앱에 로그인하는 방법이 뭐예요", ja: "アプリにログインするにはどうしますか", ru: "как войти в приложение", ar: "كيف أسجل الدخول إلى التطبيق", es: "¿cómo inicio sesión en la app?", id: "bagaimana cara masuk ke aplikasi", tr: "uygulamaya nasıl giriş yaparım", de: "wie melde ich mich in der App an", th: "จะเข้าสู่ระบบแอปได้อย่างไร",
  },
  "wallet-create": {
    en: "how do I set up a new wallet", vi: "làm sao để lập ví mới", zh: "怎么创建新钱包", ko: "새 지갑은 어떻게 만드나요", ja: "新しいウォレットの作り方を教えてください", ru: "как создать новый кошелёк", ar: "كيف أنشئ محفظة جديدة", es: "¿cómo creo una billetera nueva?", id: "bagaimana cara membuat dompet baru", tr: "yeni cüzdan nasıl oluşturulur", de: "wie erstelle ich eine neue Wallet", th: "สร้างกระเป๋าใหม่ยังไง",
  },
  "referral-code": {
    en: "where do I type the invite code from my friend", vi: "nhập mã giới thiệu của bạn ở đâu", zh: "朋友给我的邀请码在哪里填", ko: "친구 추천 코드는 어디에 입력하나요", ja: "友達の招待コードはどこに入力しますか", ru: "куда вводить пригласительный код от друга", ar: "أين أدخل رمز الدعوة من صديقي", es: "¿dónde pongo el código de invitación de mi amigo?", id: "di mana saya memasukkan kode undangan teman", tr: "arkadaşımın davet kodunu nereye girerim", de: "wo gebe ich den Einladungscode meines Freundes ein", th: "ใส่รหัสเชิญของเพื่อนตรงไหน",
  },
  "esc-swap": {
    en: "the token exchange inside the app keeps failing", vi: "giao dịch swap token trong app cứ báo lỗi", zh: "应用里的代币兑换一直失败", ko: "앱에서 토큰 스왑이 계속 실패해요", ja: "アプリ内のトークンスワップが失敗し続けます", ru: "обмен токенов в приложении постоянно завершается ошибкой", ar: "عملية مبادلة العملات داخل التطبيق تفشل دائما", es: "el swap de tokens en la app siempre falla", id: "swap token di aplikasi terus gagal", tr: "uygulamadaki token takası sürekli hata veriyor", de: "der Token-Swap in der App schlägt immer fehl", th: "สลับโทเคนในแอปล้มเหลวตลอด",
  },
  "fp-6-kyc-slow": {
    en: "my verification has been pending for days, why so slow", vi: "xác minh của mình đợi mấy ngày rồi sao lâu thế", zh: "我的认证已经等了好几天，为什么这么慢", ko: "인증이 며칠째 대기 중인데 왜 이렇게 느린가요", ja: "本人確認が何日も保留のままです、遅すぎませんか", ru: "моя верификация висит уже несколько дней, почему так долго", ar: "التحقق من هويتي معلق منذ أيام لماذا كل هذا البطء", es: "mi verificación lleva días pendiente, ¿por qué tarda tanto?", id: "verifikasi saya sudah berhari-hari pending, kenapa lama sekali", tr: "doğrulamam günlerdir beklemede neden bu kadar yavaş", de: "meine Verifizierung hängt seit Tagen, warum dauert das so lange", th: "การยืนยันตัวตนของฉันค้างมาหลายวันแล้ว ทำไมช้าจัง",
  },
  "wallet-address": {
    en: "where can I see my wallet address to receive funds", vi: "xem địa chỉ ví để nhận tiền ở đâu", zh: "在哪里可以看到我的钱包地址来收款", ko: "입금받을 내 지갑 주소는 어디서 확인하나요", ja: "受け取り用のウォレットアドレスはどこで見られますか", ru: "где посмотреть адрес моего кошелька для получения средств", ar: "أين أجد عنوان محفظتي لاستلام الأموال", es: "¿dónde veo la dirección de mi billetera para recibir fondos?", id: "di mana melihat alamat dompet untuk menerima dana", tr: "para almak için cüzdan adresimi nerede görürüm", de: "wo finde ich meine Wallet-Adresse zum Empfangen", th: "ดูที่อยู่กระเป๋าเพื่อรับเงินได้ที่ไหน",
  },
  "face-scan-black-screen": {
    en: "the camera shows only a dark screen when I scan my face", vi: "quét mặt mà camera chỉ hiện màn hình đen", zh: "刷脸的时候摄像头只显示黑屏", ko: "얼굴 스캔할 때 카메라 화면이 까맣게만 나와요", ja: "顔スキャン中にカメラが真っ黒な画面になります", ru: "при сканировании лица камера показывает чёрный экран", ar: "الكاميرا تظهر شاشة سوداء عند مسح الوجه", es: "al escanear mi cara la cámara solo muestra pantalla negra", id: "saat scan wajah kamera hanya menampilkan layar hitam", tr: "yüz taraması sırasında kamera sadece siyah ekran gösteriyor", de: "beim Gesichtsscan zeigt die Kamera nur einen schwarzen Bildschirm", th: "ตอนสแกนหน้ากล้องขึ้นแต่จอดำ",
  },
  "group-mining-create": {
    en: "how do I start a mining team with my friends", vi: "làm sao để lập nhóm đào cùng bạn bè", zh: "怎么和朋友一起建立挖矿小组", ko: "친구들과 채굴 그룹을 만들려면 어떻게 하나요", ja: "友達とマイニンググループを作るにはどうしますか", ru: "как создать майнинг-группу с друзьями", ar: "كيف أنشئ مجموعة تعدين مع أصدقائي", es: "¿cómo creo un grupo de minería con mis amigos?", id: "bagaimana cara membuat grup mining bersama teman", tr: "arkadaşlarımla madencilik grubu nasıl kurarım", de: "wie gründe ich mit Freunden eine Mining-Gruppe", th: "จะตั้งกลุ่มขุดกับเพื่อนได้อย่างไร",
  },
};

const ex = [];
for (const f of fs.readdirSync("content/templates")) {
  const t = fs.readFileSync("content/templates/" + f, "utf8").split(/^---\s*$/m);
  for (let i = 1; i < t.length; i += 2) {
    try {
      const m = yaml.parse(t[i]);
      if (m?.id) for (const e of m.match?.examples ?? []) ex.push({ id: m.id, text: String(e) });
    } catch {}
  }
}
const queries = [];
for (const [id, byLang] of Object.entries(Q)) for (const [lang, text] of Object.entries(byLang)) queries.push({ id, lang, text });

const cos = (a, b) => {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; }
  return d / Math.sqrt(x * y);
};

async function embed(url, model, texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    let r;
    for (let attempt = 0; ; attempt++) {
      r = await fetch(url + "/embeddings", { method: "POST", headers: { "content-type": "application/json", ...(process.env.EMBEDDING_BENCH_KEY ? { authorization: "Bearer " + process.env.EMBEDDING_BENCH_KEY } : {}) }, body: JSON.stringify({ model, input: texts.slice(i, i + 32) }) });
      if (r.ok || r.status === 401 || r.status === 403 || attempt >= 3) break;
      await new Promise((z) => setTimeout(z, 500 * (attempt + 1))); // gateway ngoài có lỗi rải rác: thử lại
    }
    if (!r.ok) throw new Error(await r.text());
    out.push(...(await r.json()).data.sort((a, b) => a.index - b.index).map((d) => d.embedding));
  }
  return out;
}

const arg = (n, d) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3) ?? d;
const c = {
  name: arg("model", process.env.EMBEDDING_MODEL ?? "bge-m3"),
  url: arg("url", process.env.EMBEDDING_URL ?? "http://localhost:8081/v1"),
  model: arg("model", process.env.EMBEDDING_MODEL ?? "bge-m3"),
  qprefix: arg("query-prefix", ""),
};
{
  const t0 = Date.now();
  const ev = await embed(c.url, c.model, ex.map((e) => e.text));
  const qv = await embed(c.url, c.model, queries.map((q) => (c.qprefix ?? "") + q.text));
  const ms = Date.now() - t0;
  const perLang = {};
  let ok = 0;
  const wrongs = [];
  const marg = []; const rk = [];
  queries.forEach((q, qi) => {
    const best = {};
    ex.forEach((e, i) => { const s = cos(qv[qi], ev[i]); if (!(best[e.id] >= s)) best[e.id] = s; });
    const ranked = Object.entries(best).sort((a, b) => b[1] - a[1]);
    const right = ranked[0][0] === q.id;
    (perLang[q.lang] ??= [0, 0]);
    perLang[q.lang][1]++;
    if (right) { perLang[q.lang][0]++; ok++; } else wrongs.push(`${q.lang}:${q.id}->${ranked[0][0]}`);
    const rank = ranked.findIndex((r) => r[0] === q.id); rk.push(rank); marg.push({ right, top: ranked[0][1], gap: ranked[0][1] - ranked[1][1] });
  });
  const avg = (a) => (a.reduce((s, x) => s + x, 0) / (a.length || 1)).toFixed(3);
  const rt = marg.filter((m) => m.right), wr = marg.filter((m) => !m.right);
  console.log(`\n=== ${c.name}  dim=${qv[0].length}  top1=${ok}/${queries.length} (${((100 * ok) / queries.length).toFixed(1)}%)  embed ${ms}ms for ${ex.length + queries.length} texts`);
  const at = (k) => ((100 * rk.filter((r) => r >= 0 && r < k).length) / rk.length).toFixed(1);
  console.log(`recall@1=${at(1)}%  @3=${at(3)}%  @5=${at(5)}%`);
  console.log("per-lang:", Object.entries(perLang).map(([l, [a, b]]) => `${l} ${a}/${b}`).join(" | "));
  console.log(`right: top=${avg(rt.map((m) => m.top))} gap=${avg(rt.map((m) => m.gap))} | wrong: top=${avg(wr.map((m) => m.top))} gap=${avg(wr.map((m) => m.gap))}`);
  const TAB = [0.7, 0.75, 0.8, 0.82, 0.85];
  console.log("Ngưỡng (top >= t, chênh lệch với ứng viên kế >= m): độ phủ / độ chính xác");
  for (const t of TAB) for (const m of [0.05, 0.08, 0.12]) {
    const sel = marg.filter((x) => x.top >= t && x.gap >= m);
    console.log(`  t=${t} m=${m}: ${sel.length}/${marg.length} tin, chính xác ${sel.length ? ((100 * sel.filter((x) => x.right).length) / sel.length).toFixed(0) : "-"}%`);
  }
  console.log("Sai:", wrongs.join(", "));
}
