/* InterLink Support - giao diện quản trị (vanilla JS, một tệp, không thư viện).
 *
 * Ràng buộc bảo mật (CSP: script-src 'self', style-src 'self'):
 *  - không script/style/handler inline; mọi kiểu dáng qua class CSS (chỉ chiều rộng/cao thanh biểu đồ đặt qua CSSOM);
 *  - dữ liệu từ API (kể cả tin nhắn khách - không đáng tin) CHỈ được đưa vào DOM bằng textContent / createTextNode,
 *    không bao giờ dùng innerHTML.
 *
 * Bố cục tệp: 1) tiện ích DOM  2) tiện ích hiển thị  3) API + xác thực  4) router  5) các màn hình  6) khởi động.
 */
"use strict";

(() => {
  // ==================================================================================================
  // 1. Tiện ích DOM
  // ==================================================================================================

  /** Thêm con vào phần tử: chuỗi/số -> text node, mảng -> làm phẳng, null/false -> bỏ qua. */
  function append(el, kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else if (k instanceof Node) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    }
  }

  /**
   * h(tag, attrs, ...children) - dựng phần tử an toàn.
   *  attrs: class, text, on:{event:fn}, value/checked/disabled/selected/hidden (property), còn lại là attribute.
   *  Không cho phép attribute on* (handler inline) và href/src ngoài "#", "/".
   */
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    const deferred = [];
    if (attrs != null && typeof attrs === "object" && !(attrs instanceof Node) && !Array.isArray(attrs)) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === "class") el.className = v;
        else if (k === "text") el.textContent = String(v);
        else if (k === "on") for (const [ev, fn] of Object.entries(v)) el.addEventListener(ev, fn);
        else if (k === "value" || k === "checked") deferred.push([k, v]); // đặt sau khi có option con
        else if (k === "disabled" || k === "selected" || k === "hidden") el[k] = !!v;
        else if (/^on/i.test(k)) continue;
        else if ((k === "href" || k === "src") && !/^(#|\/(?!\/))/.test(String(v))) continue;
        else if (v === true) el.setAttribute(k, "");
        else el.setAttribute(k, String(v));
      }
    } else if (attrs != null) kids.unshift(attrs);
    append(el, kids);
    for (const [k, v] of deferred) el[k] = v;
    return el;
  }

  const clear = (el) => el.replaceChildren();
  const $ = (id) => document.getElementById(id);

  const readLS = (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  const writeLS = (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* private mode: bỏ qua */
    }
  };

  // ==================================================================================================
  // 2. Tiện ích hiển thị
  // ==================================================================================================

  const fmtDate = (v) => {
    if (!v) return "-";
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("vi-VN", { hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  };
  const fmtNum = (n) => (n == null || Number.isNaN(Number(n)) ? "-" : Number(n).toLocaleString("vi-VN"));
  const fmtPct = (r, d = 1) => (r == null || Number.isNaN(Number(r)) ? "-" : `${(Number(r) * 100).toFixed(d)}%`);
  const fmtCost = (c) => `$${Number(c || 0).toFixed(4)}`;
  const short = (s, n) => {
    const t = String(s ?? "");
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  const jsonText = (v, space = 2) => {
    try {
      return JSON.stringify(v, null, space);
    } catch {
      return String(v);
    }
  };
  /** YYYY-MM-DD theo giờ Asia/Bangkok (cùng múi giờ với máy chủ), lệch `offsetDays` ngày. */
  const bangkokDate = (offsetDays = 0) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Bangkok", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(Date.now() + offsetDays * 86_400_000));

  const STATUS = {
    open: ["Đang mở", "info"],
    dormant: ["Tạm lắng", "muted"],
    resolved: ["Đã xong", "ok"],
    escalated: ["Đã chuyển support", "warn"],
    security_alerted: ["Cảnh báo bảo mật", "err"],
    in_progress: ["Đang xử lý", "warn"],
    closed: ["Đã đóng", "ok"],
    draft: ["Draft", "info"],
    pending_approval: ["Chờ duyệt", "warn"],
    published: ["Đang chạy", "ok"],
    archived: ["Lưu trữ", "muted"],
    rejected: ["Bị từ chối", "err"],
    pending: ["Chờ duyệt", "warn"],
    approved: ["Đã duyệt", "ok"],
    sending: ["Đang gửi", "warn"],
    done: ["Hoàn tất", "ok"],
    cancelled: ["Đã huỷ", "muted"],
  };
  const KIND = { TEMPLATE: "ok", ESCALATE: "warn", GROUNDED: "info", OFFTOPIC: "muted", BLOCKED: "err", SECURITY: "err" };
  const TIER = { "-1": "Không xác định", 0: "Tầng 0 · luật", 1: "Tầng 1 · từ khoá/ngữ nghĩa", 2: "Tầng 2 · LLM", 3: "Tầng 3 · tri thức" };
  const tierLabel = (t) => (t == null ? "-" : TIER[t] ?? `Tầng ${t}`);
  const CHANGE_KIND = { kb_publish: "Publish tri thức", protected_setting: "Cấu hình bảo vệ", admin_change: "Thay đổi quản trị viên" };

  const badge = (text, kind = "muted") => h("span", { class: `badge badge-${kind}` }, text);
  const statusBadge = (s) => (STATUS[s] ? badge(STATUS[s][0], STATUS[s][1]) : badge(String(s ?? "-")));
  const kindBadge = (k) => badge(String(k ?? "-"), KIND[k] || "muted");
  const chip = (t, cls = "") => h("span", { class: `chip ${cls}`.trim() }, t);
  const card = (title, ...kids) => h("div", { class: "card" }, title ? h("h2", null, title) : null, ...kids);
  const notice = (kind, ...kids) => h("div", { class: `notice notice-${kind}` }, ...kids);
  const emptyBox = (t) => h("div", { class: "empty" }, t);
  const link = (text, path, cls) => h("a", { href: `#${path}`, class: cls }, text);
  const jsonBlock = (v) => h("pre", { class: "code" }, jsonText(v));
  const val = (v) => (v == null || v === "" ? "-" : v);

  /** Danh sách "nhãn: giá trị". */
  const dl = (pairs) => h("dl", { class: "kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("dt", null, k), h("dd", null, val(v))]));

  const btn = (label, o = {}) => h("button", { type: o.type || "button", class: [o.kind ? `btn-${o.kind}` : "", o.small ? "btn-sm" : ""].filter(Boolean).join(" ") || null, disabled: o.disabled, title: o.title, on: o.on }, label);
  const field = (label, control, hint) => h("label", { class: "field" }, h("span", { class: "lbl" }, label), control, hint ? h("div", { class: "hint" }, hint) : null);
  const select = (options, value, extra = {}) => h("select", { value, ...extra }, options.map(([v, l]) => h("option", { value: v }, l)));

  /** Bảng có cuộn ngang trong khung riêng (không làm tràn trang trên điện thoại). */
  function table(cols, rows, o = {}) {
    if (!rows.length) return emptyBox(o.empty || "Không có dữ liệu");
    return h(
      "div",
      { class: "tbl-wrap" },
      h(
        "table",
        null,
        h("thead", null, h("tr", null, cols.map((c) => h("th", { class: c.cls }, c.label)))),
        h("tbody", null, rows.map((r) => h("tr", null, cols.map((c) => h("td", { class: c.cls }, c.cell(r)))))),
      ),
    );
  }

  /** Thanh ngang: items = [{label, value, text?, tone?}]. Chiều rộng đặt bằng CSSOM (không vi phạm CSP). */
  function bars(items, o = {}) {
    if (!items.length) return emptyBox(o.empty || "Không có dữ liệu");
    const max = Math.max(1e-9, ...items.map((i) => i.value));
    return h(
      "div",
      { class: "bars" },
      items.map((i) => {
        const fill = h("div", { class: `bar-fill ${i.tone || ""}`.trim() });
        fill.style.width = `${Math.max(0, (i.value / max) * 100).toFixed(1)}%`;
        return h("div", { class: "bar-row" }, h("div", { class: "bar-label", title: i.label }, i.label), h("div", { class: "bar-track" }, fill), h("div", { class: "bar-val" }, i.text ?? fmtNum(i.value)));
      }),
    );
  }

  /** Biểu đồ cột vẽ bằng div: items = [{label, value, title}]. */
  function columnChart(items) {
    if (!items.length) return emptyBox("Không có dữ liệu");
    const max = Math.max(1, ...items.map((i) => i.value));
    const chart = h("div", { class: "chart" });
    for (const i of items) {
      const bar = h("div", { class: "col-bar", title: i.title || `${i.label}: ${fmtNum(i.value)}` });
      bar.style.height = `${((i.value / max) * 100).toFixed(1)}%`;
      chart.append(h("div", { class: "col" }, bar));
    }
    const inner = h("div", null, chart, h("div", { class: "chart-labels" }, items.map((i) => h("span", null, i.label))));
    inner.style.minWidth = `${items.length * 25}px`;
    return h("div", { class: "chart-scroll" }, inner);
  }

  const stat = (label, value, sub) => h("div", { class: "card stat" }, h("div", { class: "label" }, label), h("div", { class: "value" }, value), sub ? h("div", { class: "sub" }, sub) : null);

  function toast(msg, kind = "err") {
    const box = $("toasts");
    while (box.children.length >= 5) box.firstChild.remove();
    const t = h("div", { class: `toast toast-${kind}`, role: kind === "err" ? "alert" : "status" }, h("div", { class: "msg" }, msg), h("button", { type: "button", "aria-label": "Đóng", on: { click: () => t.remove() } }, "×"));
    box.append(t);
    setTimeout(() => t.remove(), kind === "err" ? 20_000 : 5_000);
  }

  function noteKb(v) {
    if (v == null) return;
    state.kbVersion = v;
    $("footer").textContent = `Phiên bản kho tri thức (kbVersion): ${v}`;
  }

  // ==================================================================================================
  // 3. API + xác thực
  // ==================================================================================================

  const state = { me: null, kbVersion: null, returnTo: null };
  const RANK = { viewer: 1, admin: 2, owner: 3 };
  const can = (min) => !!state.me && RANK[state.me.role] >= RANK[min];

  class ApiError extends Error {
    constructor(status, message) {
      super(message);
      this.status = status;
      this.handled = false; // true: đã xử lý (vd. chuyển về đăng nhập), không cần toast thêm
    }
  }

  const qs = (q) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q || {})) if (v != null && v !== "") p.set(k, String(v));
    const s = p.toString();
    return s ? `?${s}` : "";
  };

  /**
   * Gọi API JSON. Mọi thao tác ghi gửi header x-requested-with (chống CSRF) và luôn có body JSON
   * (Fastify từ chối content-type json với body rỗng). 401 -> về màn hình đăng nhập.
   */
  async function api(method, path, body, o = {}) {
    const init = { method, credentials: "same-origin", headers: { accept: "application/json" } };
    if (method !== "GET") {
      init.headers["x-requested-with"] = "admin-web";
      init.headers["content-type"] = "application/json";
      init.body = JSON.stringify(body ?? {});
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw new ApiError(0, "Không kết nối được máy chủ");
    }
    let data = null;
    const text = await res.text();
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { error: short(text, 200) };
      }
    }
    if (!res.ok) {
      let msg = (data && typeof data.error === "string" && data.error) || `Lỗi ${res.status}`;
      if (data && Array.isArray(data.details) && data.details.length) msg += `: ${data.details.join("; ")}`;
      const err = new ApiError(res.status, msg);
      if (res.status === 401 && !o.quiet401) {
        err.handled = true;
        onUnauthorized();
      }
      throw err;
    }
    return data;
  }
  const get = (path, q, o) => api("GET", path + qs(q), null, o);
  const post = (path, body, o) => api("POST", path, body, o);
  const put = (path, body) => api("PUT", path, body);
  const patch = (path, body) => api("PATCH", path, body);
  const del = (path) => api("DELETE", path, {});

  function onUnauthorized() {
    if (state.me) showLogin("Phiên đăng nhập đã hết hạn, vui lòng đăng nhập lại.");
  }

  function reportError(e) {
    if (e && e.handled) return;
    toast(e && e.message ? e.message : String(e), "err");
  }

  /** Chạy một thao tác bất đồng bộ khi bấm nút: khoá nút, bắt lỗi -> toast, tuỳ chọn báo thành công. */
  async function run(button, fn, okMsg) {
    if (button) button.disabled = true;
    try {
      const r = await fn();
      if (okMsg) toast(okMsg, "ok");
      return r;
    } catch (e) {
      reportError(e);
      return undefined;
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** Điền nội dung vào `box` từ loader bất đồng bộ (bỏ qua kết quả cũ nếu đã có lần tải mới hơn). */
  function loadInto(box, loader) {
    const tok = (box._tok = (box._tok || 0) + 1);
    if (!box.firstChild) box.append(h("div", { class: "loading" }, "Đang tải..."));
    loader().then(
      (node) => {
        if (box._tok !== tok) return;
        clear(box);
        append(box, [node]);
      },
      (e) => {
        if (box._tok !== tok) return;
        clear(box);
        if (e && e.handled) return;
        box.append(errorBox(e, () => loadInto(box, loader)));
      },
    );
  }
  /** Tạo khung tự tải; loader nhận hàm reload để làm mới sau khi thao tác. */
  function lazy(loader) {
    const box = h("div");
    const reload = () => loadInto(box, () => loader(reload));
    reload();
    return box;
  }
  function errorBox(e, retry) {
    if (e && e.status === 403) return notice("warn", "Bạn không có quyền xem mục này. ", e.message);
    return notice("err", h("div", null, (e && e.message) || "Lỗi không xác định"), retry ? h("div", { class: "actions" }, btn("Thử lại", { small: true, on: { click: retry } })) : null);
  }

  // ---------------------------------------------------------------- đăng nhập
  function showLogin(msg) {
    state.me = null;
    $("topbar").hidden = true;
    $("footer").textContent = "";
    const wrap = h("div", { class: "login-wrap" });
    const box = h("div", { class: "card" });
    wrap.append(box);
    let telegramId = readLS("admin_tg_id") || "";
    let flash = msg || null;
    // nhớ trang đang xem để quay lại sau khi đăng nhập
    if (location.hash && location.hash !== "#" && location.hash !== "#/login") state.returnTo = location.hash;

    const drawId = () => {
      clear(box);
      const input = h("input", { type: "text", inputmode: "numeric", autocomplete: "username", placeholder: "vd. 7835139312", value: telegramId, required: true });
      const submit = h("button", { type: "submit", class: "btn-primary" }, "Gửi mã");
      box.append(
        h("h1", null, "Đăng nhập quản trị"),
        flash ? notice("warn", flash) : null,
        h("p", { class: "muted" }, "Nhập Telegram ID của bạn. Mã đăng nhập gồm 6 chữ số sẽ được bot InterLink Support gửi vào cuộc trò chuyện Telegram của bạn (hết hạn sau 5 phút)."),
        h(
          "form",
          {
            on: {
              submit: async (ev) => {
                ev.preventDefault();
                const id = input.value.trim();
                if (!/^\d{3,15}$/.test(id)) return toast("Telegram ID phải là số");
                await run(submit, async () => {
                  await post("/api/auth/request-code", { telegramId: Number(id) }, { quiet401: true });
                  telegramId = id;
                  writeLS("admin_tg_id", id);
                  flash = null;
                  drawCode();
                });
              },
            },
          },
          field("Telegram ID", input, "Bạn cần từng nhắn tin cho bot thì bot mới gửi được mã. Để bảo mật, hệ thống trả lời giống nhau dù ID có phải quản trị viên hay không."),
          submit,
        ),
      );
      input.focus();
    };

    const drawCode = () => {
      clear(box);
      const input = h("input", { type: "text", inputmode: "numeric", autocomplete: "one-time-code", maxlength: 6, pattern: "[0-9]{6}", placeholder: "000000", required: true });
      const submit = h("button", { type: "submit", class: "btn-primary" }, "Đăng nhập");
      box.append(
        h("h1", null, "Nhập mã xác nhận"),
        notice("info", `Nếu ${telegramId} là quản trị viên, mã 6 số đã được gửi tới Telegram của bạn. Hãy mở cuộc trò chuyện với bot để xem mã.`),
        h(
          "form",
          {
            on: {
              submit: async (ev) => {
                ev.preventDefault();
                const code = input.value.trim();
                if (!/^\d{6}$/.test(code)) return toast("Mã gồm đúng 6 chữ số");
                await run(submit, async () => {
                  await post("/api/auth/verify", { telegramId: Number(telegramId), code }, { quiet401: true });
                  await startSession();
                });
              },
            },
          },
          field("Mã 6 chữ số", input),
          h(
            "div",
            { class: "actions" },
            submit,
            btn("Gửi lại mã", {
              on: {
                click: (ev) =>
                  run(ev.currentTarget, async () => {
                    await post("/api/auth/request-code", { telegramId: Number(telegramId) }, { quiet401: true });
                  }, "Đã gửi lại mã (nếu chưa vượt giới hạn 3 mã / 15 phút)"),
              },
            }),
            btn("Đổi Telegram ID", { kind: "link", on: { click: drawId } }),
          ),
        ),
      );
      input.focus();
    };

    drawId();
    clear($("app"));
    $("app").append(wrap);
    if (location.hash !== "#/login") history.replaceState(null, "", "#/login");
  }

  async function logout() {
    try {
      await post("/api/auth/logout", {}, { quiet401: true });
    } catch {
      /* dù lỗi vẫn về màn hình đăng nhập */
    }
    showLogin();
  }

  /** Sau khi có cookie phiên: lấy thông tin người dùng, dựng khung và hiển thị route hiện tại. */
  async function startSession() {
    state.me = await get("/api/me", null, { quiet401: true });
    buildChrome();
    if (!location.hash || location.hash === "#/login" || location.hash === "#") history.replaceState(null, "", state.returnTo || "#/dashboard");
    state.returnTo = null;
    render();
  }

  // ==================================================================================================
  // 4. Router theo hash: #/tên-màn-hình/tham-số?bộ-lọc=...
  // ==================================================================================================

  function parseHash() {
    const raw = location.hash.replace(/^#/, "") || "/dashboard";
    const [p, q = ""] = raw.split("?");
    const parts = p
      .split("/")
      .filter(Boolean)
      .map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
    return { parts, query: new URLSearchParams(q) };
  }

  /** Đổi tham số lọc trên hash hiện tại (giá trị rỗng/0 = bỏ). Nếu không đổi gì thì vẽ lại (làm mới). */
  function setQuery(patchObj) {
    const { query } = parseHash();
    const path = (location.hash.replace(/^#/, "") || "/dashboard").split("?")[0];
    for (const [k, v] of Object.entries(patchObj)) {
      if (v == null || v === "" || v === 0) query.delete(k);
      else query.set(k, String(v));
    }
    const s = query.toString();
    const next = `#${path}${s ? `?${s}` : ""}`;
    if (next === location.hash) render();
    else location.hash = next;
  }
  const go = (path) => {
    const next = `#${path}`;
    if (location.hash === next) render();
    else location.hash = next;
  };
  const enc = encodeURIComponent;

  function pager(query, limit, count) {
    const offset = Number(query.get("offset") || 0);
    return h(
      "div",
      { class: "pager" },
      btn("‹ Trước", { disabled: offset <= 0, on: { click: () => setQuery({ offset: Math.max(0, offset - limit) }) } }),
      h("span", { class: "muted" }, `Từ mục ${offset + 1}`),
      btn("Sau ›", { disabled: count < limit, on: { click: () => setQuery({ offset: offset + limit }) } }),
    );
  }

  const ROUTES = [
    { path: "dashboard", label: "Tổng quan", view: viewDashboard },
    { path: "conversations", label: "Hội thoại", view: viewConversations },
    { path: "users", label: "Người dùng", view: viewUsers },
    { path: "tickets", label: "Ticket", view: viewTickets },
    { path: "kb", label: "Kho tri thức", view: viewKb },
    { path: "translations", label: "Bản dịch", view: viewTranslations },
    { path: "changes", label: "Chờ duyệt", view: viewChanges, min: "admin" },
    { path: "settings", label: "Cấu hình", view: viewSettings },
    { path: "usage", label: "Usage", view: viewUsage },
    { path: "eval", label: "Câu hỏi mẫu", view: viewEval },
    { path: "audit", label: "Nhật ký", view: viewAudit, min: "admin" },
    { path: "broadcasts", label: "Thông báo hàng loạt", view: viewBroadcasts, min: "owner" },
  ];

  function buildChrome() {
    $("topbar").hidden = false;
    const who = $("who");
    clear(who);
    who.append(
      h("span", null, state.me.name || "Quản trị viên", " ", h("span", { class: "muted" }, `#${state.me.id}`)),
      badge(state.me.role, state.me.role === "owner" ? "ok" : state.me.role === "admin" ? "info" : "muted"),
      btn("Đăng xuất", { small: true, on: { click: logout } }),
    );
    const nav = $("nav");
    clear(nav);
    for (const r of ROUTES) if (!r.min || can(r.min)) nav.append(h("a", { href: `#/${r.path}`, "data-route": r.path }, r.label));
  }

  function markNav(name) {
    for (const a of $("nav").children) a.classList.toggle("active", a.getAttribute("data-route") === name);
  }

  function render() {
    if (!state.me) return;
    const { parts, query } = parseHash();
    const name = parts[0] || "dashboard";
    const route = ROUTES.find((r) => r.path === name);
    markNav(name);
    const app = $("app");
    clear(app);
    if (!route) {
      app.append(notice("warn", "Không tìm thấy trang. ", link("Về Tổng quan", "/dashboard")));
      return;
    }
    if (route.min && !can(route.min)) {
      app.append(notice("warn", "Chỉ owner mới dùng được mục này."));
      return;
    }
    app.append(route.view({ parts: parts.slice(1), query }));
    window.scrollTo(0, 0);
    refreshKbVersion();
  }

  /** /healthz là điểm công khai, rẻ: dùng để hiển thị kbVersion nhỏ ở chân trang. */
  async function refreshKbVersion() {
    try {
      const res = await fetch("/healthz", { credentials: "same-origin" });
      if (res.ok) noteKb((await res.json()).kbVersion);
    } catch {
      /* bỏ qua */
    }
  }

  // ==================================================================================================
  // 5. Các màn hình
  // ==================================================================================================

  const pageHead = (title, ...extra) => h("div", { class: "page-head" }, h("h1", null, title), extra);

  /** Form chọn khoảng ngày dùng chung cho Tổng quan và Usage. */
  function rangeForm(range) {
    const from = h("input", { type: "date", value: range.from, required: true });
    const to = h("input", { type: "date", value: range.to, required: true });
    const preset = (label, days) => btn(label, { small: true, on: { click: () => setQuery({ from: bangkokDate(-days), to: bangkokDate(0) }) } });
    return h(
      "form",
      { class: "form-row", on: { submit: (ev) => (ev.preventDefault(), setQuery({ from: from.value, to: to.value })) } },
      h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Từ ngày"), from),
      h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Đến ngày"), to),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn-primary" }, "Xem"), preset("Hôm nay", 0), preset("7 ngày", 6), preset("30 ngày", 29)),
    );
  }

  // ---------------------------------------------------------------- 2. Tổng quan
  function viewDashboard({ query }) {
    return lazy(async () => {
      const d = await get("/api/dashboard", { from: query.get("from"), to: query.get("to") });
      noteKb(d.health && d.health.kbVersion);
      const total = d.rates.decisions || 0;
      const tierItems = d.byTier.map((t) => ({ label: tierLabel(t.tier), value: t.n, text: `${fmtNum(t.n)} (${fmtPct(total ? t.n / total : null, 0)})` }));
      const kindItems = d.byKind.map((k) => ({ label: k.kind, value: k.n, tone: k.kind === "ESCALATE" ? "warn" : k.kind === "BLOCKED" || k.kind === "SECURITY" ? "err" : "", text: `${fmtNum(k.n)} (${fmtPct(total ? k.n / total : null, 0)})` }));
      const hl = d.health || {};
      const cronBadge = (s) => badge(String(s ?? "-"), s === "ok" ? "ok" : s === "error" ? "err" : "muted");

      return h(
        "div",
        null,
        pageHead("Tổng quan"),
        rangeForm(d.range),
        h(
          "div",
          { class: "grid stats" },
          stat("Tin nhắn khách", fmtNum(d.totals.messages), `${d.range.from} → ${d.range.to}`),
          stat("Người dùng", fmtNum(d.totals.users), "khách có gửi tin"),
          stat("Quyết định của bot", fmtNum(total)),
          stat("Tỉ lệ chuyển support", fmtPct(d.rates.escalateRate), "ESCALATE / quyết định"),
          stat("Tỉ lệ không dùng LLM", fmtPct(d.rates.zeroLlmRate), "tầng 0-1: 0 token"),
        ),
        h("div", { class: "grid grid-2" }, card("Theo tầng xử lý", bars(tierItems)), card("Theo loại quyết định", bars(kindItems))),
        h(
          "div",
          { class: "grid grid-2" },
          card("Template được dùng nhiều nhất", bars(d.topTemplates.map((t) => ({ label: t.templateId, value: t.n })))),
          card("Số lần chuyển support theo ngày", bars(d.escalationsByDay.map((e) => ({ label: e.day, value: e.n, tone: "warn" })))),
        ),
        card(
          "Câu chưa khớp (câu hỏi mới)",
          notice("info", "Đây là những câu bot không tìm được template hay tri thức phù hợp nên đã chuyển support. Hãy thêm template hoặc tài liệu tri thức để bot tự trả lời được lần sau. ", can("admin") ? link("Thêm trong Kho tri thức", "/kb/new") : null),
          table(
            [
              { label: "Thời gian", cell: (r) => fmtDate(r.at), cls: "nowrap" },
              { label: "Câu hỏi của khách", cell: (r) => h("span", { class: "pre-wrap" }, r.text) },
              { label: "Lý do", cell: (r) => r.reason },
            ],
            d.unmatched,
            { empty: "Không có câu chưa khớp trong khoảng này" },
          ),
        ),
        card(
          "Sức khoẻ hệ thống",
          dl([
            ["kbVersion", String(val(hl.kbVersion))],
            ["LLM", hl.llmConfigured ? badge("đã cấu hình", "ok") : badge("chưa cấu hình: chỉ chạy tầng 0-1", "warn")],
            ["Job nền", chipsOf(hl.jobs)],
            ["Hộp thư đi", chipsOf(hl.outbox)],
          ]),
          h("hr", { class: "sep" }),
          h("h3", null, "Job lỗi (dead)"),
          table(
            [
              { label: "ID", cell: (r) => r.id, cls: "num" },
              { label: "Loại", cell: (r) => r.type },
              { label: "Lần thử", cell: (r) => r.attempts, cls: "num" },
              { label: "Lỗi cuối", cell: (r) => short(r.last_error, 200) },
              { label: "Kết thúc", cell: (r) => fmtDate(r.finished_at), cls: "nowrap" },
            ],
            hl.dead || [],
            { empty: "Không có job lỗi" },
          ),
          h("hr", { class: "sep" }),
          h("h3", null, "Tác vụ định kỳ (cron)"),
          table(
            [
              { label: "Tên", cell: (r) => r.name },
              { label: "Lần chạy cuối", cell: (r) => fmtDate(r.last_run_at), cls: "nowrap" },
              { label: "Kết quả", cell: (r) => cronBadge(r.last_status) },
              { label: "Lỗi", cell: (r) => short(r.last_error, 200) },
              { label: "Chi tiết", cell: (r) => (r.last_result == null ? "-" : h("span", { class: "small mono", title: jsonText(r.last_result) }, short(jsonText(r.last_result, 0), 80))) },
            ],
            hl.cron || [],
            { empty: "Chưa có cron nào chạy" },
          ),
        ),
        card(
          "Thống kê tuần",
          table(
            [
              { label: "Tuần bắt đầu", cell: (r) => r.week_start, cls: "nowrap" },
              { label: "Hội thoại", cell: (r) => fmtNum(r.total_conversations), cls: "num" },
              { label: "Chủ đề hàng đầu", cell: (r) => topIssues(r.top_issues) },
              { label: "Câu mới", cell: (r) => fmtNum(r.new_questions), cls: "num" },
              { label: "Chưa xong", cell: (r) => fmtNum(r.unresolved), cls: "num" },
            ],
            d.weekly || [],
            { empty: "Chưa có thống kê tuần" },
          ),
        ),
      );
    });
  }
  const chipsOf = (obj) => {
    const e = Object.entries(obj || {});
    return e.length ? h("div", { class: "chips" }, e.map(([k, v]) => chip(`${k}: ${fmtNum(v)}`, k === "dead" && v > 0 ? "chip-err" : ""))) : "-";
  };
  const topIssues = (v) => {
    let arr = v;
    if (typeof v === "string") {
      try {
        arr = JSON.parse(v);
      } catch {
        return v;
      }
    }
    return Array.isArray(arr) ? arr.map((x) => `${x.issue} (${x.count})`).join(", ") : "-";
  };

  // ---------------------------------------------------------------- 3. Hội thoại
  /** "Tên @username (id)"; viewer không nhận được tên/username nên chỉ còn ID đã che. */
  const person = (name, username, id) => {
    const label = [name, username ? `@${username}` : null].filter(Boolean).join(" ");
    return label ? `${label} (${id})` : String(id);
  };

  function viewConversations({ parts, query }) {
    if (parts[0]) return viewConversation(parts[0]);
    const LIMIT = 30;
    const status = query.get("status") || "";
    const q = query.get("q") || "";
    const userId = query.get("userId") || "";
    const statusSel = select([["", "Tất cả trạng thái"], ...Object.entries(STATUS).filter(([k]) => ["open", "dormant", "resolved", "escalated", "security_alerted"].includes(k)).map(([k, v]) => [k, v[0]])], status);
    const qIn = h("input", { type: "search", value: q, placeholder: "Chủ đề, tên, @username, ID, nội dung tin..." });
    return h(
      "div",
      null,
      pageHead("Hội thoại"),
      h(
        "form",
        { class: "form-row", on: { submit: (ev) => (ev.preventDefault(), setQuery({ status: statusSel.value, q: qIn.value.trim(), offset: 0 })) } },
        h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Trạng thái"), statusSel),
        h("div", { class: "field" }, h("span", { class: "lbl" }, "Tìm kiếm"), qIn),
        h("div", { class: "actions" }, h("button", { type: "submit", class: "btn-primary" }, "Lọc")),
      ),
      userId ? notice("info", `Đang lọc theo người dùng ${userId}. `, btn("Bỏ lọc", { small: true, on: { click: () => setQuery({ userId: "", offset: 0 }) } })) : null,
      lazy(async () => {
        const r = await get("/api/episodes", { status, q, userId, limit: LIMIT, offset: query.get("offset") || 0 });
        if (!r.items.length) return emptyBox("Không có hội thoại nào");
        return h(
          "div",
          null,
          h(
            "div",
            { class: "list" },
            r.items.map((e) =>
              h(
                "a",
                { class: "row-card", href: `#/conversations/${e.id}` },
                h("div", { class: "row-top" }, h("span", { class: "row-title" }, e.issue || "(chưa có chủ đề)"), statusBadge(e.status), e.topic_group ? badge(e.topic_group) : null),
                h("div", { class: "row-meta" }, h("span", null, `#${e.id}`), h("span", null, person(e.user_name, e.user_username, e.user_id)), h("span", null, fmtDate(e.last_activity_at)), h("span", null, `${fmtNum(e.message_count)} tin`)),
                e.last_bot_text ? h("div", { class: "row-body" }, e.last_bot_text) : null,
              ),
            ),
          ),
          pager(query, LIMIT, r.items.length),
        );
      }),
    );
  }

  /** Các nhãn cho tóm tắt cuộn của episode. */
  const SUMMARY_LABEL = { issue: "Vấn đề", user_reported: "Khách báo", unresolved_points: "Điểm còn treo" };

  function viewConversation(idStr) {
    return lazy(async () => {
      const d = await get(`/api/episodes/${enc(idStr)}`);
      const ep = d.episode;
      const admin = can("admin");

      // Gắn quyết định vào tin nhắn khách (decisions.message_id là tin khách); hiển thị sau các câu trả lời của bot.
      const byMsg = new Map();
      for (const dec of d.decisions) if (dec.message_id != null) (byMsg.get(dec.message_id) || byMsg.set(dec.message_id, []).get(dec.message_id)).push(dec);
      const shown = new Set();
      const timeline = h("div", { class: "timeline" });
      let pending = [];
      const flush = () => {
        for (const dec of pending) timeline.append(decisionCard(dec));
        pending = [];
      };
      for (const m of d.messages) {
        if (m.direction === "in") {
          flush();
          pending = byMsg.get(m.id) || [];
          for (const dec of pending) shown.add(dec.id);
        }
        timeline.append(bubble(m, admin));
      }
      flush();
      const orphan = d.decisions.filter((x) => !shown.has(x.id));

      const summary = ep.summary && typeof ep.summary === "object" ? dl(Object.entries(ep.summary).map(([k, v]) => [SUMMARY_LABEL[k] || k, typeof v === "string" ? v : jsonText(v)])) : h("span", { class: "muted" }, "Chưa có tóm tắt (tạo khi hội thoại đủ dài và có LLM).");

      return h(
        "div",
        null,
        pageHead(`Hội thoại #${ep.id}`, statusBadge(ep.status), link("← Danh sách", "/conversations", "small")),
        h(
          "div",
          { class: "grid grid-2" },
          card(
            "Thông tin",
            dl([
              ["Chủ đề", ep.issue],
              ["Nhóm chủ đề", ep.topic_group],
              ["Template gần nhất", ep.last_template_id ? h("code", null, ep.last_template_id) : null],
              ["Hành động bot gần nhất", ep.last_bot_action],
              ["Mở lúc", fmtDate(ep.opened_at)],
              ["Hoạt động cuối", fmtDate(ep.last_activity_at)],
              ["Đóng lúc", ep.closed_at ? fmtDate(ep.closed_at) : null],
              ["Hội thoại cha", d.parent ? link(`#${d.parent.id} · ${d.parent.issue || "(không chủ đề)"}`, `/conversations/${d.parent.id}`) : null],
            ]),
          ),
          card(
            "Khách hàng",
            d.user
              ? dl([
                  ["Tên", d.user.name],
                  ["Username", d.user.username ? `@${d.user.username}` : null],
                  ["Telegram ID", String(d.user.telegram_id)],
                  ["Ngôn ngữ", d.user.language],
                  ["Lần đầu / cuối", `${fmtDate(d.user.first_seen)} / ${fmtDate(d.user.last_seen)}`],
                  ["Số lần thấy", fmtNum(d.user.seen_count)],
                  ["Xem thêm", admin ? link("Trang người dùng", `/users/${d.user.telegram_id}`) : link("Các hội thoại của khách", `/conversations?userId=${enc(ep.user_id)}`)],
                ])
              : h("span", { class: "muted" }, "Không có thông tin"),
          ),
        ),
        card("Tóm tắt hội thoại", summary),
        d.tickets.length ? card("Ticket của hội thoại", d.tickets.map((t) => ticketMini(t))) : null,
        card("Diễn biến", d.messages.length ? timeline : emptyBox("Chưa có tin nhắn")),
        orphan.length ? card("Quyết định không gắn với tin nhắn", h("div", { class: "timeline" }, orphan.map((x) => decisionCard(x)))) : null,
        card(
          "Sự kiện",
          table(
            [
              { label: "Thời gian", cell: (e) => fmtDate(e.at), cls: "nowrap" },
              { label: "Loại", cell: (e) => chip(e.type) },
              { label: "Nội dung", cell: (e) => h("span", { class: "small mono" }, short(jsonText(e.payload, 0), 300)) },
            ],
            d.events,
            { empty: "Không có sự kiện" },
          ),
        ),
      );
    });
  }

  function ticketMini(t) {
    return h(
      "div",
      { class: "row-card" },
      h("div", { class: "row-top" }, h("strong", null, `Ticket #${t.id}`), statusBadge(t.status), t.category ? badge(t.category) : null, t.error_code ? chip(t.error_code) : null),
      h("div", { class: "row-meta" }, h("span", null, `PIC: ${t.pic || "-"}`), h("span", null, fmtDate(t.created_at))),
      t.reason ? h("div", null, t.reason) : null,
      Array.isArray(t.required_info) && t.required_info.length ? h("ul", null, t.required_info.map((x) => h("li", null, String(x)))) : null,
      t.notes ? h("div", { class: "pre-wrap muted" }, t.notes) : null,
    );
  }

  /** Bong bóng tin nhắn: khách bên trái, bot bên phải. Ảnh khách gửi chỉ admin+ xem được (/api/media). */
  function bubble(m, admin) {
    const meta = h("div", { class: "meta" }, h("strong", null, m.direction === "in" ? "Khách" : "Bot"), h("span", null, fmtDate(m.created_at)));
    if (m.tier != null) meta.append(badge(tierLabel(m.tier)));
    if (m.template_id) meta.append(chip(m.template_id));
    if (m.language) meta.append(badge(m.language));
    const b = h("div", { class: `bubble ${m.direction}` }, meta);
    if (m.text) b.append(h("div", { class: "text" }, m.text));
    if (m.image_ref) {
      const src = `/api/media?ref=${enc(m.image_ref)}`;
      b.append(h("div", { class: "small" }, "Ảnh", m.image_type ? ` (${m.image_type})` : "", admin ? [" · ", h("a", { href: src, target: "_blank", rel: "noopener noreferrer" }, "mở ảnh")] : " · chỉ admin xem được"));
      if (admin) {
        const img = h("img", { class: "thumb", src, loading: "lazy", alt: "Ảnh khách gửi" });
        img.addEventListener("error", () => img.replaceWith(h("div", { class: "small muted" }, "(ảnh đã hết hạn lưu hoặc không đọc được)")));
        b.append(img);
      }
    }
    if (!m.text && !m.image_ref) b.append(h("div", { class: "muted" }, "(không có nội dung)"));
    return b;
  }

  /** "Vì sao bot trả lời thế này": quyết định + vết các cổng. */
  function decisionCard(d) {
    const gates = d.gates && typeof d.gates === "object" ? d.gates : {};
    const notes = d.notes && typeof d.notes === "object" ? d.notes : {};
    const sum = h("summary", null, "Vì sao bot trả lời thế này · ", kindBadge(d.kind), " ", d.template_id ? h("code", null, d.template_id) : null, d.tier != null ? ` · ${tierLabel(d.tier)}` : null, d.via ? ` · ${d.via}` : null);
    return h(
      "div",
      { class: "decision" },
      h(
        "details",
        { class: "dec", open: d.kind === "ESCALATE" },
        sum,
        dl([
          ["Loại", kindBadge(d.kind)],
          ["Tầng", tierLabel(d.tier)],
          ["Template", d.template_id ? h("code", null, d.template_id) : null],
          ["Cách khớp (via)", d.via],
          ["Lý do", d.reason],
          ["Phiên bản KB", d.kb_version],
          ["Thời điểm", fmtDate(d.created_at)],
        ]),
        traceView({ candidates: d.candidates, gates: gates.steps, ranked: gates.ranked, chosen: d.template_id, followUp: notes.follow_up, llm: notes.llm }),
        notesView(notes),
      ),
    );
  }

  /** Ghi chú của pipeline (cờ, ticket, chống spam...). */
  function notesView(n) {
    const flags = [];
    if (n.new_question) flags.push(badge("Câu hỏi mới: chưa có trong kho", "warn"));
    if (n.reopened) flags.push(badge("Mở lại hội thoại cũ", "info"));
    if (n.switched != null) flags.push(badge(`Đổi chủ đề từ hội thoại #${n.switched}`, "info"));
    if (n.ticket_id != null) flags.push(badge(`Ticket #${n.ticket_id}`, "warn"));
    if (n.anti) flags.push(badge(`Chống spam: ${typeof n.anti === "string" ? n.anti : jsonText(n.anti, 0)}`, "err"));
    const list = Array.isArray(n.notes) ? n.notes : [];
    if (!flags.length && !list.length) return null;
    return h("div", null, h("h3", null, "Ghi chú của pipeline"), flags.length ? h("div", { class: "chips" }, flags) : null, list.length ? h("ul", null, list.map((x) => h("li", null, String(x)))) : null);
  }

  /**
   * Vết định tuyến dùng chung cho quyết định đã lưu và "Thử câu hỏi":
   * ứng viên (bị loại ở cổng nào, vì sao), các cổng, bảng xếp hạng.
   */
  function traceView(t) {
    const steps = Array.isArray(t.gates) ? t.gates : [];
    const removed = new Map();
    for (const s of steps) for (const r of s.removed || []) if (!removed.has(r.templateId)) removed.set(r.templateId, { gate: s.gate, reason: r.reason });
    const cands = Array.isArray(t.candidates) ? t.candidates : [];
    const ranked = Array.isArray(t.ranked) ? t.ranked : [];
    const box = h("div");
    box.append(
      h("h3", null, "Ứng viên từ tầng 0-1"),
      cands.length
        ? h(
            "div",
            { class: "chips" },
            cands.map((id) => {
              const rm = removed.get(id);
              return h("span", { class: `chip ${rm ? "chip-err" : id === t.chosen ? "chip-ok" : ""}`.trim(), title: rm ? `Bị loại ở cổng ${rm.gate}: ${rm.reason}` : null }, id);
            }),
          )
        : h("p", { class: "muted" }, "Không có ứng viên theo từ khoá/rule."),
    );
    if (t.followUp) box.append(h("p", null, "Follow-up: ", badge(String(t.followUp), "info")));
    if (t.llm && t.llm.action) box.append(h("p", null, "LLM chọn: ", badge(String(t.llm.action), "info")));
    if (steps.length) {
      box.append(h("h3", null, "Các cổng quyết định"));
      for (const s of steps) {
        const rem = s.removed || [];
        box.append(
          h(
            "div",
            { class: `gate ${rem.length ? "hit" : ""}`.trim() },
            h("strong", null, `Cổng ${s.gate} · ${s.name}`),
            rem.length ? h("ul", null, rem.map((r) => h("li", null, h("code", null, r.templateId), ` bị loại: ${r.reason}`))) : h("span", { class: "muted" }, " (không loại ứng viên nào)"),
          ),
        );
      }
      box.append(h("p", { class: "hint" }, "Cổng 1 (bảo mật, chống spam) và cổng 6 (kiểm tra đầu ra) do pipeline xử lý riêng, không nằm trong danh sách này."));
    }
    if (ranked.length) {
      box.append(
        h("h3", null, "Xếp hạng (cổng 5)"),
        table(
          [
            { label: "#", cell: (r) => String(ranked.indexOf(r) + 1), cls: "num" },
            { label: "Template", cell: (r) => h("code", null, r.templateId) },
            { label: "Kiểu khớp", cell: (r) => r.kind },
            { label: "Ưu tiên", cell: (r) => r.priority, cls: "num" },
            { label: "Độ dài cụm", cell: (r) => r.phraseLen, cls: "num" },
          ],
          ranked,
        ),
      );
    }
    return box;
  }

  // ---------------------------------------------------------------- 4. Người dùng
  function viewUsers({ parts, query }) {
    if (parts[0]) return viewUser(parts[0]);
    const LIMIT = 30;
    const q = query.get("q") || "";
    const qIn = h("input", { type: "search", value: q, placeholder: "Tên, @username hoặc ID" });
    const admin = can("admin");
    return h(
      "div",
      null,
      pageHead("Người dùng"),
      !admin ? notice("info", "Quyền viewer: ID bị che, không xem được chi tiết người dùng.") : null,
      h("form", { class: "form-row", on: { submit: (ev) => (ev.preventDefault(), setQuery({ q: qIn.value.trim(), offset: 0 })) } }, h("div", { class: "field" }, h("span", { class: "lbl" }, "Tìm kiếm"), qIn), h("div", { class: "actions" }, h("button", { type: "submit", class: "btn-primary" }, "Tìm"))),
      lazy(async () => {
        const r = await get("/api/users", { q, limit: LIMIT, offset: query.get("offset") || 0 });
        if (!r.items.length) return emptyBox("Không có người dùng");
        return h(
          "div",
          null,
          h(
            "div",
            { class: "list" },
            r.items.map((u) => {
              const inner = [
                h("div", { class: "row-top" }, h("span", { class: "row-title" }, person(u.name, u.username, u.telegram_id)), u.language ? badge(u.language) : null),
                h("div", { class: "row-meta" }, h("span", null, `ID ${u.telegram_id}`), h("span", null, `Lần cuối: ${fmtDate(u.last_seen)}`), h("span", null, `${fmtNum(u.episode_count)} hội thoại`), h("span", null, `${fmtNum(u.seen_count)} lần thấy`)),
              ];
              return admin ? h("a", { class: "row-card", href: `#/users/${enc(u.telegram_id)}` }, inner) : h("div", { class: "row-card" }, inner);
            }),
          ),
          pager(query, LIMIT, r.items.length),
        );
      }),
    );
  }

  function viewUser(idStr) {
    return lazy(async () => {
      const d = await get(`/api/users/${enc(idStr)}`);
      const u = d.user;
      const a = d.antispam;
      const blocked = a && a.blocked_until && new Date(a.blocked_until).getTime() > Date.now();
      return h(
        "div",
        null,
        pageHead(person(u.name, u.username, u.telegram_id), link("← Danh sách", "/users", "small"), link("Xem hội thoại", `/conversations?userId=${enc(u.telegram_id)}`, "small")),
        h(
          "div",
          { class: "grid grid-2" },
          card(
            "Hồ sơ",
            dl([
              ["Telegram ID", String(u.telegram_id)],
              ["Tên", u.name],
              ["Username", u.username ? `@${u.username}` : null],
              ["Ngôn ngữ", u.language],
              ["Lần đầu thấy", fmtDate(u.first_seen)],
              ["Lần cuối thấy", fmtDate(u.last_seen)],
              ["Số lần thấy", fmtNum(u.seen_count)],
              ["Cờ (flags)", u.flags && Object.keys(u.flags).length ? h("span", { class: "small mono" }, jsonText(u.flags, 0)) : null],
            ]),
          ),
          card(
            "Chống spam",
            a
              ? dl([
                  ["Số tin lạc đề", fmtNum(a.offtopic_count)],
                  ["Trạng thái", blocked ? badge(`đang bị chặn tới ${fmtDate(a.blocked_until)}`, "err") : badge("không bị chặn", "ok")],
                  ["Hoạt động cuối", fmtDate(a.last_seen)],
                ])
              : h("span", { class: "muted" }, "Chưa có bản ghi chống spam."),
          ),
        ),
        card(
          "Hội thoại gần đây",
          d.episodes.length
            ? h(
                "div",
                { class: "list" },
                d.episodes.map((e) =>
                  h(
                    "a",
                    { class: "row-card", href: `#/conversations/${e.id}` },
                    h("div", { class: "row-top" }, h("span", { class: "row-title" }, e.issue || "(chưa có chủ đề)"), statusBadge(e.status)),
                    h("div", { class: "row-meta" }, h("span", null, `#${e.id}`), h("span", null, fmtDate(e.last_activity_at))),
                  ),
                ),
              )
            : emptyBox("Chưa có hội thoại"),
        ),
        card(
          "Sự kiện chống spam / bảo mật",
          table(
            [
              { label: "Thời gian", cell: (e) => fmtDate(e.at), cls: "nowrap" },
              { label: "Loại", cell: (e) => chip(e.type) },
              { label: "Nội dung", cell: (e) => h("span", { class: "small mono" }, short(jsonText(e.payload, 0), 240)) },
            ],
            d.events,
            { empty: "Không có sự kiện" },
          ),
        ),
      );
    });
  }

  // ---------------------------------------------------------------- 5. Ticket
  function viewTickets({ query }) {
    const LIMIT = 30;
    const status = query.get("status") || "";
    const sel = select([["", "Tất cả trạng thái"], ["open", "Đang mở"], ["in_progress", "Đang xử lý"], ["closed", "Đã đóng"]], status, { on: { change: () => setQuery({ status: sel.value, offset: 0 }) } });
    return h(
      "div",
      null,
      pageHead("Ticket"),
      h("div", { class: "form-row" }, h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Trạng thái"), sel)),
      lazy(async () => {
        const r = await get("/api/tickets", { status, limit: LIMIT, offset: query.get("offset") || 0 });
        if (!r.items.length) return emptyBox("Không có ticket");
        return h("div", null, h("div", { class: "list" }, r.items.map(ticketCard)), pager(query, LIMIT, r.items.length));
      }),
    );
  }

  /** Thẻ ticket: admin+ đổi trạng thái ngay khi chọn, lưu PIC/ghi chú bằng nút Lưu. */
  function ticketCard(t) {
    const edit = can("admin");
    const head = h("div", { class: "row-top" }, h("strong", null, `#${t.id}`), h("span", { class: "status-slot" }, statusBadge(t.status)), t.category ? badge(t.category) : null, t.error_code ? chip(t.error_code) : null);
    const slot = head.querySelector(".status-slot");
    const meta = h(
      "div",
      { class: "row-meta" },
      h("span", null, person(t.user_name, t.user_username, t.user_id)),
      h("span", null, fmtDate(t.created_at)),
      t.source_template_id ? h("span", null, "template: ", h("code", null, t.source_template_id)) : null,
      t.episode_id ? link(`Hội thoại #${t.episode_id}`, `/conversations/${t.episode_id}`) : null,
    );
    const body = h("div", null, t.reason ? h("div", null, t.reason) : null, Array.isArray(t.required_info) && t.required_info.length ? h("div", null, h("span", { class: "muted" }, "Cần khách cung cấp:"), h("ul", null, t.required_info.map((x) => h("li", null, String(x))))) : null);
    if (!edit) return h("div", { class: "row-card" }, head, meta, body, t.pic ? h("div", { class: "small" }, `PIC: ${t.pic}`) : null, t.notes ? h("div", { class: "pre-wrap muted" }, t.notes) : null);

    const status = select([["open", "Đang mở"], ["in_progress", "Đang xử lý"], ["closed", "Đã đóng"]], t.status);
    status.addEventListener("change", () =>
      run(status, async () => {
        await patch(`/api/tickets/${t.id}`, { status: status.value });
        t.status = status.value;
        slot.replaceChildren(statusBadge(t.status));
      }, "Đã cập nhật trạng thái"),
    );
    const pic = h("input", { type: "text", value: t.pic || "", maxlength: 80, placeholder: "Người phụ trách" });
    const notes = h("textarea", { maxlength: 4000, placeholder: "Ghi chú nội bộ" });
    notes.value = t.notes || "";
    const save = btn("Lưu PIC / ghi chú", {
      small: true,
      on: {
        click: () => {
          const b = {};
          if (pic.value !== (t.pic || "")) b.pic = pic.value.trim();
          if (notes.value !== (t.notes || "")) b.notes = notes.value;
          if ((b.pic === "" && t.pic) || (b.notes === "" && t.notes)) return toast("Máy chủ chưa hỗ trợ xoá trắng PIC/ghi chú (giữ giá trị cũ khi để trống).");
          if (b.pic === "") delete b.pic;
          if (b.notes === "") delete b.notes;
          if (!Object.keys(b).length) return toast("Không có thay đổi để lưu", "info");
          run(save, async () => {
            await patch(`/api/tickets/${t.id}`, b);
            if (b.pic != null) t.pic = b.pic;
            if (b.notes != null) t.notes = b.notes;
          }, "Đã lưu");
        },
      },
    });
    return h("div", { class: "row-card" }, head, meta, body, h("div", { class: "form-row" }, h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Trạng thái"), status), h("div", { class: "field" }, h("span", { class: "lbl" }, "PIC"), pic)), h("div", { class: "field" }, h("span", { class: "lbl" }, "Ghi chú"), notes), save);
  }

  // ---------------------------------------------------------------- 6. Kho tri thức
  const KB_TABS = [["Tài liệu", "/kb"], ["Thử câu hỏi", "/kb/try"], ["Template", "/kb/templates"]];

  function viewKb({ parts, query }) {
    const [sub, arg] = parts;
    const active = sub === "try" || sub === "templates" ? `/kb/${sub}` : "/kb";
    const tabs = h("nav", { class: "tabs" }, KB_TABS.map(([label, path]) => h("a", { href: `#${path}`, class: path === active ? "active" : null }, label)));
    let body;
    if (sub === "try") body = kbTry(query);
    else if (sub === "templates") body = kbTemplates();
    else if (sub === "doc" && arg) body = kbDoc(arg);
    else if (sub === "new") body = kbEditorNew(query);
    else if (sub === "edit" && arg) body = kbEditorEdit(arg);
    else body = kbDocs();
    return h("div", null, pageHead("Kho tri thức"), tabs, body);
  }

  function kbDocs() {
    return lazy(async () => {
      const r = await get("/api/kb/documents");
      noteKb(r.kbVersion);
      return h(
        "div",
        null,
        can("admin") ? h("div", { class: "actions" }, link("+ Tài liệu mới", "/kb/new", "btn btn-primary")) : null,
        card(
          null,
          table(
            [
              { label: "Slug", cell: (d) => link(d.slug, `/kb/doc/${enc(d.slug)}`) },
              { label: "Tiêu đề", cell: (d) => d.title },
              { label: "Loại", cell: (d) => badge(d.kind === "templates" ? "template" : "tri thức", d.kind === "templates" ? "info" : "muted") },
              { label: "Đang chạy", cell: (d) => (d.published_version ? badge(`v${d.published_version}`, "ok") : badge("chưa publish", "warn")) },
              { label: "Mới nhất", cell: (d) => `v${d.latest_version}` },
              { label: "", cell: (d) => link("Các phiên bản", `/kb/doc/${enc(d.slug)}`) },
            ],
            r.items,
          ),
        ),
      );
    });
  }

  function kbDoc(slug) {
    return lazy(async (reload) => {
      const r = await get(`/api/kb/documents/${enc(slug)}`);
      const doc = r.document;
      const published = r.versions.find((v) => v.status === "published");
      const base = published || r.versions[0];
      const newQuery = `slug=${enc(doc.slug)}&kind=${enc(doc.kind)}&title=${enc(doc.title || doc.slug)}${base ? `&from=${base.id}` : ""}`;
      return h(
        "div",
        null,
        h("div", { class: "page-head" }, h("h2", null, doc.slug), badge(doc.kind === "templates" ? "template" : "tri thức", "info"), link("← Tài liệu", "/kb", "small")),
        can("admin") ? h("div", { class: "actions" }, link("Tạo phiên bản mới", `/kb/new?${newQuery}`, "btn btn-primary")) : null,
        card(
          "Các phiên bản",
          table(
            [
              { label: "Bản", cell: (v) => `v${v.version}`, cls: "nowrap" },
              { label: "Trạng thái", cell: (v) => h("span", null, statusBadge(v.status), v.requires_second_approval ? [" ", badge("cần 2 người duyệt", "warn")] : null) },
              { label: "Tác giả", cell: (v) => v.author },
              { label: "Duyệt bởi", cell: (v) => v.approved_by },
              { label: "Tạo", cell: (v) => fmtDate(v.created_at), cls: "nowrap" },
              { label: "Publish", cell: (v) => (v.published_at ? fmtDate(v.published_at) : "-"), cls: "nowrap" },
              {
                label: "",
                cell: (v) =>
                  h(
                    "div",
                    { class: "actions" },
                    link(v.status === "draft" || v.status === "rejected" ? "Sửa" : "Xem", `/kb/edit/${v.id}`),
                    can("admin") && v.status === "archived"
                      ? btn("Rollback", {
                          small: true,
                          kind: "danger",
                          title: "Tạo bản mới từ nội dung phiên bản này rồi publish",
                          on: {
                            click: (ev) => {
                              if (!confirm(`Rollback tài liệu ${doc.slug} về phiên bản v${v.version}?\nHệ thống tạo phiên bản mới từ nội dung này và publish (lịch sử được giữ).`)) return;
                              run(ev.currentTarget, async () => {
                                const res = await post(`/api/kb/documents/${enc(doc.slug)}/rollback`, { version: v.version });
                                toast(res.status === "pending_approval" ? "Đã đề xuất rollback: cần một quản trị viên khác duyệt tại mục Chờ duyệt." : "Đã rollback và publish.", "ok");
                                reload();
                              });
                            },
                          },
                        })
                      : null,
                  ),
              },
            ],
            r.versions,
          ),
        ),
      );
    });
  }

  const readFile = (f) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result));
      r.onerror = () => reject(new Error("Không đọc được tệp"));
      r.readAsText(f, "utf-8");
    });

  /** Vùng soạn markdown: textarea + chọn tệp .md cục bộ (FileReader) + bộ đếm ký tự. */
  function editorPane({ md, readonly, onLoadedFile }) {
    const ta = h("textarea", { class: "editor", spellcheck: "false", readonly: readonly || null, "aria-label": "Nội dung markdown" });
    ta.value = md;
    const count = h("span", { class: "hint" });
    const upd = () => (count.textContent = `${fmtNum(ta.value.length)} ký tự`);
    ta.addEventListener("input", upd);
    upd();
    const picker = h("input", { type: "file", accept: ".md,.markdown,.txt,text/markdown,text/plain" });
    picker.addEventListener("change", async () => {
      const f = picker.files && picker.files[0];
      if (!f) return;
      if (f.size > 1_000_000) return toast("Tệp quá lớn (tối đa 1 MB)");
      try {
        ta.value = await readFile(f);
        upd();
        ta.dispatchEvent(new Event("input"));
        if (onLoadedFile) onLoadedFile(f);
        toast(`Đã nạp ${f.name} vào ô soạn thảo (chưa lưu)`, "ok");
      } catch (e) {
        reportError(e);
      } finally {
        picker.value = "";
      }
    });
    const node = h("div", null, readonly ? null : field("Nạp từ tệp .md trên máy", picker, "Nội dung tệp được đưa vào ô bên dưới, bạn có thể sửa rồi lưu."), h("label", { class: "field" }, h("span", { class: "lbl" }, "Markdown"), ta, count));
    return { node, ta };
  }

  function kbEditorNew(query) {
    return lazy(async () => {
      if (!can("admin")) return notice("warn", "Chỉ admin/owner được tạo tài liệu.");
      const from = query.get("from");
      let md = "";
      if (from) md = ((await get(`/api/kb/versions/${enc(from)}`)).version || {}).source_md || "";
      const existing = !!query.get("slug");
      const slug = h("input", { type: "text", value: query.get("slug") || "", maxlength: 80, placeholder: "vd. faq-kyc", readonly: existing || null });
      const kind = select([["templates", "templates (câu trả lời có sẵn)"], ["knowledge", "knowledge (tài liệu tri thức)"]], query.get("kind") || "templates", { disabled: existing });
      const title = h("input", { type: "text", value: query.get("title") || "", maxlength: 200, placeholder: "Tiêu đề (tuỳ chọn)" });
      const pane = editorPane({
        md,
        onLoadedFile: (f) => {
          if (!slug.value && !existing) slug.value = f.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        },
      });
      const create = btn(existing ? "Tạo phiên bản Draft & kiểm tra" : "Tạo Draft & kiểm tra", {
        kind: "primary",
        on: {
          click: () => {
            if (!/^[a-z0-9][a-z0-9-]+$/.test(slug.value)) return toast("Slug chỉ gồm chữ thường, số, gạch ngang (tối thiểu 2 ký tự)");
            if (pane.ta.value.trim().length < 10) return toast("Nội dung markdown quá ngắn");
            run(create, async () => {
              const body = { slug: slug.value, kind: kind.value, md: pane.ta.value };
              if (title.value.trim()) body.title = title.value.trim();
              const r = await post("/api/kb/documents", body);
              toast(r.report && r.report.ok ? "Đã tạo Draft, kiểm tra đạt." : "Đã tạo Draft nhưng kiểm tra chưa đạt: xem báo cáo.", r.report && r.report.ok ? "ok" : "info");
              go(`/kb/edit/${r.version.id}`);
            });
          },
        },
      });
      return h(
        "div",
        null,
        h("div", { class: "page-head" }, h("h2", null, existing ? `Phiên bản mới cho ${query.get("slug")}` : "Tài liệu mới"), link("← Tài liệu", "/kb", "small")),
        existing ? notice("info", "Để trống ô Tiêu đề thì tài liệu giữ nguyên tiêu đề hiện có.") : null,
        h("div", { class: "card" }, h("div", { class: "form-row" }, field("Slug", slug, "chữ thường, số, gạch ngang"), field("Loại", kind), field("Tiêu đề", title)), pane.node, h("div", { class: "actions" }, create)),
      );
    });
  }

  function kbEditorEdit(idStr) {
    return lazy(async (reload) => {
      const v = (await get(`/api/kb/versions/${enc(idStr)}`)).version;
      const doc = (await get(`/api/kb/documents/${enc(v.slug)}`)).document;
      const editable = can("admin") && (v.status === "draft" || v.status === "rejected");
      const pane = editorPane({ md: v.source_md || "", readonly: !editable });
      const reportBox = h("div", null, renderReport(v.report));
      const saved = { md: v.source_md || "" };
      const dirty = () => pane.ta.value !== saved.md;
      const showReport = (r) => {
        clear(reportBox);
        reportBox.append(renderReport(r));
      };

      const save = btn("Lưu Draft", {
        on: {
          click: () =>
            run(save, async () => {
              const r = await put(`/api/kb/versions/${v.id}`, { md: pane.ta.value });
              saved.md = pane.ta.value;
              showReport(r.report);
              toast(r.report.ok ? "Đã lưu Draft, kiểm tra đạt." : "Đã lưu Draft nhưng kiểm tra chưa đạt.", r.report.ok ? "ok" : "info");
            }),
        },
      });
      const validate = btn("Kiểm tra", {
        title: "Chạy lại 6 bước kiểm tra trên bản đã lưu",
        on: {
          click: () => {
            if (dirty()) return toast("Có thay đổi chưa lưu: bấm Lưu Draft trước (Lưu Draft cũng chạy kiểm tra).");
            run(validate, async () => showReport((await post(`/api/kb/versions/${v.id}/validate`, {})).report));
          },
        },
      });
      const publish = btn("Publish", {
        kind: "primary",
        on: {
          click: () => {
            if (dirty()) return toast("Có thay đổi chưa lưu: bấm Lưu Draft trước khi Publish.");
            if (!confirm(`Publish ${v.slug} v${v.version}? Bot sẽ dùng nội dung này ngay sau khi nạp lại.`)) return;
            run(publish, async () => {
              try {
                const r = await post(`/api/kb/versions/${v.id}/publish`, {});
                toast(r.status === "pending_approval" ? "Đã gửi đề xuất Publish: cần một quản trị viên KHÁC duyệt tại mục Chờ duyệt." : "Đã publish. Bot sẽ nạp nội dung mới.", "ok");
              } catch (e) {
                // máy chủ đã ghi lại báo cáo mới trước khi từ chối: tải lại để xem lý do
                reportError(e);
              }
              reload();
            });
          },
        },
      });

      const actions = [];
      if (editable) actions.push(save, validate);
      if (can("admin") && v.status === "draft") actions.push(publish);
      if (can("admin") && v.status !== "draft" && v.status !== "rejected") actions.push(link("Tạo Draft mới từ bản này", `/kb/new?slug=${enc(v.slug)}&kind=${enc(doc.kind)}&title=${enc(doc.title || v.slug)}&from=${v.id}`, "btn"));
      if (!can("admin")) actions.push(h("span", { class: "muted" }, "Quyền viewer: chỉ xem."));

      const statusNote =
        v.status === "pending_approval"
          ? notice("warn", "Bản này đang chờ NGƯỜI THỨ HAI duyệt (người đề xuất không tự duyệt được). ", link("Mở mục Chờ duyệt", "/changes"))
          : v.status === "published"
            ? notice("ok", "Đây là phiên bản đang chạy. Muốn sửa hãy tạo Draft mới từ bản này.")
            : v.status === "archived"
              ? notice("info", "Phiên bản cũ (chỉ đọc). Có thể Rollback từ trang phiên bản của tài liệu.")
              : v.status === "rejected"
                ? notice("warn", "Đề xuất Publish của bản này đã bị từ chối. Sửa và Lưu Draft để đưa về Draft.")
                : null;

      return h(
        "div",
        null,
        h("div", { class: "page-head" }, h("h2", null, `${v.slug} · v${v.version}`), statusBadge(v.status), link("← Các phiên bản", `/kb/doc/${enc(v.slug)}`, "small")),
        dl([["Tác giả", v.author], ["Tạo", fmtDate(v.created_at)], ["Duyệt bởi", v.approved_by], ["Loại", doc.kind]]),
        statusNote,
        h("div", { class: "card" }, h("div", { class: "actions" }, actions), editable ? h("p", { class: "hint" }, "Publish có thể trả về \"chờ duyệt\": nếu tài liệu có luật bảo mật (SECURITY_RULE) thì chỉ owner được đề xuất và một người khác phải duyệt.") : null, pane.node),
        reportBox,
      );
    });
  }

  /** Báo cáo kiểm tra 6 bước + hồi quy + replay. */
  function renderReport(r) {
    if (!r || typeof r !== "object") return notice("info", "Chưa có báo cáo kiểm tra.");
    const steps = Array.isArray(r.steps) ? r.steps : [];
    const wrap = h("div", { class: "card" });
    wrap.append(h("div", { class: "row-top" }, h("h2", null, "Báo cáo kiểm tra"), badge(r.ok ? "Đạt" : "Chưa đạt", r.ok ? "ok" : "err"), r.templateCount != null ? badge(`${r.templateCount} template`) : null, r.chunkCount != null ? badge(`${r.chunkCount} đoạn tri thức`) : null));
    if (r.note) wrap.append(h("p", { class: "muted" }, String(r.note)));
    if (r.securityRules && r.securityRules.length) wrap.append(notice("warn", "Có luật bảo mật (SECURITY_RULE): ", h("span", { class: "chips" }, r.securityRules.map((x) => chip(x))), ". Chỉ owner được đề xuất Publish và cần người thứ hai duyệt."));
    const LABEL = { ok: "Đạt", warning: "Cảnh báo", error: "Lỗi" };
    wrap.append(
      h(
        "div",
        { class: "steps" },
        steps.map((s) =>
          h("div", { class: `step ${s.status}` }, h("div", { class: "head" }, s.name, badge(LABEL[s.status] || s.status, s.status === "ok" ? "ok" : s.status === "warning" ? "warn" : "err")), s.details && s.details.length ? h("ul", null, s.details.map((x) => h("li", null, String(x)))) : null),
        ),
      ),
    );
    if (r.regression) {
      const g = r.regression;
      wrap.append(
        h("hr", { class: "sep" }),
        h("h3", null, `Hồi quy trên ${fmtNum(g.total)} câu mẫu`),
        bars([
          { label: "Trước", value: g.accuracyBefore, text: fmtPct(g.accuracyBefore) },
          { label: "Sau (bản này)", value: g.accuracyAfter, text: fmtPct(g.accuracyAfter), tone: g.accuracyAfter < g.accuracyBefore ? "err" : "ok" },
        ]),
        g.changed && g.changed.length
          ? table(
              [
                { label: "Câu hỏi", cell: (c) => c.question },
                { label: "Trước", cell: (c) => chip(c.before) },
                { label: "Sau", cell: (c) => chip(c.after) },
              ],
              g.changed,
            )
          : h("p", { class: "muted" }, "Không có câu mẫu nào đổi kết quả."),
      );
    }
    if (r.replay) {
      const p = r.replay;
      wrap.append(
        h("hr", { class: "sep" }),
        h("h3", null, `Replay tin nhắn thật: ${fmtNum(p.changed)}/${fmtNum(p.total)} tin sẽ đổi câu trả lời`),
        p.samples && p.samples.length
          ? table(
              [
                { label: "Tin nhắn", cell: (s) => s.text },
                { label: "Trước", cell: (s) => chip(s.before) },
                { label: "Sau", cell: (s) => chip(s.after) },
              ],
              p.samples,
            )
          : h("p", { class: "muted" }, "Không có tin nào đổi."),
      );
    }
    return wrap;
  }

  /** "Thử câu hỏi này": xem template nào sẽ được chọn (tầng 0-1, không tốn token) và vì sao. */
  function kbTry(query) {
    const q = h("input", { type: "text", value: query.get("q") || "", maxlength: 500, placeholder: "Nhập câu hỏi của khách...", required: true });
    const img = select([["", "Không có ảnh"], ["kyc_email", "kyc_email · email KYC"], ["kyc_queue_screen", "kyc_queue_screen · màn hình hàng chờ KYC"], ["error_dialog", "error_dialog · hộp thoại lỗi"], ["app_screen", "app_screen · màn hình app"], ["unrelated", "unrelated · ảnh không liên quan"], ["unreadable", "unreadable · ảnh không đọc được"]], query.get("image_type") || "");
    const last = h("input", { type: "text", value: query.get("last") || "", placeholder: "vd. FP-5b (tuỳ chọn)" });
    const out = h("div");
    const go1 = async () => {
      if (!q.value.trim()) return toast("Hãy nhập câu hỏi");
      clear(out);
      out.append(h("div", { class: "loading" }, "Đang thử..."));
      try {
        const r = await get("/api/kb/try", { q: q.value.trim(), image_type: img.value, last: last.value.trim() });
        clear(out);
        out.append(tryResult(r));
      } catch (e) {
        clear(out);
        reportError(e);
      }
    };
    const form = h(
      "form",
      { class: "card", on: { submit: (ev) => (ev.preventDefault(), go1()) } },
      h("div", { class: "form-row" }, field("Câu hỏi", q), field("Loại ảnh đính kèm", img), field("Template trước đó", last, "giả lập câu hỏi nối tiếp")),
      h("div", { class: "actions" }, h("button", { type: "submit", class: "btn-primary" }, "Thử"), h("span", { class: "hint" }, "Chỉ chạy tầng 0-1 (không gọi LLM, không tốn token).")),
    );
    if (q.value) setTimeout(go1, 0);
    return h("div", null, form, out);
  }

  function tryResult(r) {
    const o = r.outcome || {};
    const chosen = o.kind === "TEMPLATE" ? o.templateId : null;
    const t = r.trace || {};
    return h(
      "div",
      null,
      card(
        "Kết quả",
        dl([
          ["Quyết định", kindBadge(o.kind)],
          ["Khoá kết quả", chip(r.key)],
          ["Template", chosen ? h("code", null, chosen) : null],
          ["Tầng", tierLabel(o.tier)],
          ["Cách khớp (via)", o.via],
          ["Lý do", o.reason],
          ["Template nguồn", o.sourceTemplateId],
        ]),
        r.answer ? h("div", null, h("h3", null, "Câu trả lời (tiếng Anh)"), h("div", { class: "tpl-answer" }, r.answer)) : h("p", { class: "muted" }, chosen ? "Không lấy được nội dung câu trả lời." : "Không có câu trả lời dựng sẵn cho kết quả này."),
      ),
      card("Vết quyết định", traceView({ candidates: t.candidates, gates: t.gates, ranked: t.ranked, chosen, followUp: t.followUp, llm: t.llm }), Array.isArray(t.notes) && t.notes.length ? h("div", null, h("h3", null, "Ghi chú"), h("ul", null, t.notes.map((n) => h("li", null, String(n))))) : null),
    );
  }

  function kbTemplates() {
    return lazy(async () => {
      const r = await get("/api/templates");
      noteKb(r.kbVersion);
      const search = h("input", { type: "search", placeholder: "Tìm theo id hoặc nhóm..." });
      const holder = h("div");
      const draw = () => {
        const s = search.value.trim().toLowerCase();
        const rows = r.items.filter((t) => !s || t.id.toLowerCase().includes(s) || String(t.group || "").toLowerCase().includes(s));
        clear(holder);
        holder.append(
          h("p", { class: "hint" }, `${fmtNum(rows.length)} / ${fmtNum(r.items.length)} template${rows.length > 300 ? " (hiển thị 300 đầu)" : ""}`),
          table(
            [
              { label: "ID", cell: (t) => h("code", null, t.id) },
              { label: "Nhóm", cell: (t) => t.group },
              { label: "Chế độ", cell: (t) => t.response_mode },
              { label: "Ưu tiên", cell: (t) => t.priority, cls: "num" },
              { label: "Ngôn ngữ", cell: (t) => h("div", { class: "chips" }, t.langs.map((l) => chip(l))) },
              { label: "Từ khoá", cell: (t) => t.keywords, cls: "num" },
              { label: "Ticket", cell: (t) => (t.ticket ? h("span", { class: "small mono" }, short(jsonText(t.ticket, 0), 60)) : "-") },
              { label: "Câu trả lời (EN)", cell: (t) => h("span", { class: "small pre-wrap" }, t.answer_en) },
            ],
            rows.slice(0, 300),
          ),
        );
      };
      search.addEventListener("input", draw);
      draw();
      return h("div", null, h("div", { class: "form-row" }, h("div", { class: "field" }, search)), card(null, holder));
    });
  }

  // ---------------------------------------------------------------- 7. Bản dịch
  function viewTranslations({ query }) {
    const status = query.get("status") ?? "pending";
    const sel = select([["pending", "Chờ duyệt"], ["approved", "Đã duyệt"], ["", "Tất cả"]], status, { on: { change: () => setQuery({ status: sel.value === "" ? "all" : sel.value }) } });
    const realStatus = status === "all" ? "" : status;
    if (status === "all") sel.value = "";
    return h(
      "div",
      null,
      pageHead("Bản dịch"),
      notice("info", "Bản dịch tự động được tạo một lần khi khách dùng ngôn ngữ chưa có sẵn và chờ người duyệt. Bạn có thể sửa nội dung rồi bấm Duyệt."),
      h("div", { class: "form-row" }, h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Trạng thái"), sel)),
      lazy(async (reload) => {
        const [r, tpl] = await Promise.all([get("/api/translations", { status: realStatus }), get("/api/templates").catch(() => null)]);
        const en = new Map((tpl ? tpl.items : []).map((t) => [t.id, t.answer_en]));
        if (!r.items.length) return emptyBox("Không có bản dịch nào");
        return h(
          "div",
          { class: "list" },
          r.items.map((t) => {
            const ta = h("textarea", { maxlength: 4096, "aria-label": "Nội dung bản dịch", readonly: !can("admin") || null });
            ta.value = t.text;
            const approve = btn(t.status === "approved" ? "Cập nhật & duyệt lại" : "Duyệt", {
              kind: "primary",
              small: true,
              on: {
                click: () =>
                  run(approve, async () => {
                    const body = { template_id: t.template_id, lang: t.lang };
                    if (ta.value !== t.text) body.text = ta.value;
                    await post("/api/translations/approve", body);
                    reload();
                  }, "Đã duyệt bản dịch"),
              },
            });
            return h(
              "div",
              { class: "row-card" },
              h("div", { class: "row-top" }, h("code", null, t.template_id), badge(t.lang, "info"), statusBadge(t.status), badge(t.origin === "llm" ? "LLM dịch" : "người sửa")),
              en.get(t.template_id) ? h("div", { class: "hint pre-wrap" }, `Bản gốc (EN): ${en.get(t.template_id)}`) : null,
              ta,
              can("admin") ? h("div", { class: "actions" }, approve) : null,
            );
          }),
        );
      }),
    );
  }

  // ---------------------------------------------------------------- 8. Chờ duyệt
  function changePreview(c) {
    const p = c.payload || {};
    if (c.kind === "kb_publish") return h("div", null, "Tài liệu ", h("code", null, String(p.slug)), " · phiên bản (id) ", link(String(p.versionId), `/kb/edit/${enc(p.versionId)}`), " · ", link("xem báo cáo", `/kb/edit/${enc(p.versionId)}`));
    if (c.kind === "admin_change") return dl([["Hành động", p.action === "remove" ? badge("Gỡ quản trị viên", "err") : badge("Thêm / đổi quyền", "info")], ["Telegram ID", String(p.telegramId)], ["Quyền", p.role]]);
    if (c.kind === "protected_setting") return h("div", null, h("div", null, "Khoá: ", h("code", null, String(p.key))), jsonBlock(p.value));
    return jsonBlock(p);
  }

  function viewChanges({ query }) {
    const status = query.get("status") || "pending";
    const sel = select([["pending", "Chờ duyệt"], ["approved", "Đã duyệt"], ["rejected", "Đã từ chối"]], status, { on: { change: () => setQuery({ status: sel.value }) } });
    return h(
      "div",
      null,
      pageHead("Chờ duyệt"),
      notice("info", "Các thay đổi nhạy cảm cần MỘT NGƯỜI KHÁC duyệt: Publish tài liệu có luật bảo mật, cấu hình bảo vệ và thay đổi quản trị viên. Máy chủ từ chối việc tự duyệt thay đổi do chính bạn đề xuất."),
      h("div", { class: "form-row" }, h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Trạng thái"), sel)),
      lazy(async (reload) => {
        const r = await get("/api/changes", { status });
        if (!r.items.length) return emptyBox("Không có thay đổi nào");
        return h(
          "div",
          { class: "list" },
          r.items.map((c) => {
            const mine = c.proposed_by === (state.me && state.me.id);
            const decide = (action, label) =>
              btn(label, {
                small: true,
                kind: action === "approve" ? "primary" : "danger",
                title: action === "approve" && mine ? "Bạn là người đề xuất: máy chủ sẽ từ chối" : null,
                on: {
                  click: (ev) => {
                    if (!confirm(`${label} thay đổi #${c.id} (${CHANGE_KIND[c.kind] || c.kind})?`)) return;
                    run(ev.currentTarget, async () => {
                      await post(`/api/changes/${c.id}/${action}`, {});
                      reload();
                    }, action === "approve" ? "Đã duyệt" : "Đã từ chối");
                  },
                },
              });
            return h(
              "div",
              { class: "row-card" },
              h("div", { class: "row-top" }, h("strong", null, `#${c.id}`), badge(CHANGE_KIND[c.kind] || c.kind, "info"), statusBadge(c.status), mine ? badge("do bạn đề xuất", "muted") : null),
              h("div", { class: "row-meta" }, h("span", null, `Người đề xuất: ${c.proposed_by}`), h("span", null, fmtDate(c.proposed_at))),
              changePreview(c),
              c.status === "pending" && can("admin") ? h("div", { class: "actions" }, decide("approve", "Duyệt"), decide("reject", "Từ chối")) : null,
            );
          }),
        );
      }),
    );
  }

  // ---------------------------------------------------------------- 9. Cấu hình
  const SETTING_DESC = {
    "router.semantic_confident": "Điểm ngữ nghĩa tối thiểu để bot tin một ứng viên chỉ-ngữ-nghĩa (0-1).",
    "router.semantic_margin": "Chênh lệch điểm tối thiểu với ứng viên xếp sau (0-1).",
    "router.semantic_suggest": "Dưới mức này coi như không có ứng viên (0-1).",
    "router.tier3_mode": "Cách trả lời từ tri thức: trích nguyên văn (extractive) hoặc sinh có trích dẫn (generative).",
    "router.tier3_min_score": "Điểm tối thiểu của đoạn tri thức để được dùng.",
    "router.too_short_max_chars": "Tin ngắn hơn hoặc bằng số ký tự này bị coi là lời chào/quá ngắn.",
    "episode.t_gap_minutes": "Im lặng quá số phút này thì hội thoại chuyển sang tạm lắng.",
    "episode.t_abandon_days": "Tạm lắng quá số ngày này thì tự đóng.",
    "episode.summary_every_k": "Tóm tắt cuộn sau mỗi K tin chưa tóm tắt (cần LLM).",
    "episode.closed_lookback_days": "Số ngày nhìn lại hội thoại đã đóng để nối tiếp khi khách quay lại.",
    "episode.ask_when_unclear": "Hỏi lại khách khi chưa rõ họ tiếp tục chủ đề cũ hay hỏi việc mới.",
    "antispam.stale_days": "Xoá bản ghi chống spam không hoạt động quá số ngày này.",
    "alerts.escalation_daily_threshold": "Cảnh báo owner khi số lần chuyển support trong ngày vượt ngưỡng.",
    "alerts.new_questions_threshold": "Cảnh báo khi số câu hỏi mới vượt ngưỡng (cần bổ sung template).",
    "alerts.whitepaper_stale_days": "Cảnh báo khi đồng bộ whitepaper quá số ngày.",
    "limits.tokens_per_user_day": "Ngân sách token mỗi khách mỗi ngày; vượt thì không gọi LLM cho khách đó.",
    "batching.window_ms": "Cửa sổ gom các tin nhắn liên tiếp (ms).",
    "retention.media_days": "Số ngày lưu ảnh khách gửi.",
  };
  const SETTING_ENUM = { "router.tier3_mode": ["extractive", "generative"] };

  function viewSettings() {
    return lazy(async (reload) => {
      const s = await get("/api/settings");
      const edit = can("admin");
      const groups = new Map();
      for (const it of s.items) {
        const g = it.key.split(".")[0];
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g).push(it);
      }
      const GROUP_LABEL = { router: "Định tuyến", episode: "Hội thoại", antispam: "Chống spam", alerts: "Cảnh báo", limits: "Giới hạn", batching: "Gom tin nhắn", retention: "Lưu trữ" };

      const settingRow = (it) => {
        let control;
        let read;
        if (typeof it.default === "boolean") {
          control = select([["true", "Bật"], ["false", "Tắt"]], String(it.value), { disabled: !edit });
          read = () => control.value === "true";
        } else if (typeof it.default === "number") {
          control = h("input", { type: "number", step: "any", min: "0", value: String(it.value), disabled: !edit });
          read = () => (control.value.trim() === "" ? NaN : Number(control.value));
        } else if (SETTING_ENUM[it.key]) {
          control = select(SETTING_ENUM[it.key].map((x) => [x, x]), String(it.value), { disabled: !edit });
          read = () => control.value;
        } else {
          control = h("input", { type: "text", value: String(it.value), disabled: !edit });
          read = () => control.value;
        }
        const saveBtn = btn("Lưu", {
          small: true,
          kind: "primary",
          on: {
            click: () => {
              const v = read();
              if (typeof v === "number" && !Number.isFinite(v)) return toast("Giá trị số không hợp lệ");
              run(saveBtn, async () => {
                await put(`/api/settings/${enc(it.key)}`, { value: v });
                reload();
              }, `Đã lưu ${it.key}`);
            },
          },
        });
        const resetBtn = btn("Về mặc định", { small: true, on: { click: () => (control.value = String(it.default)) } });
        return h(
          "div",
          { class: "form-row" },
          h("label", { class: "field" }, h("span", { class: "lbl" }, h("code", null, it.key), " ", it.custom ? badge("tuỳ chỉnh", "info") : badge("mặc định")), control, h("div", { class: "hint" }, SETTING_DESC[it.key] || "", ` Mặc định: ${String(it.default)}.`)),
          edit ? h("div", { class: "actions" }, saveBtn, resetBtn) : null,
        );
      };

      const nodes = [pageHead("Cấu hình"), edit ? null : notice("info", "Quyền viewer: chỉ xem cấu hình.")];
      for (const [g, items] of groups) nodes.push(card(GROUP_LABEL[g] || g, items.map(settingRow)));
      if (can("owner")) nodes.push(protectedSection(s));
      return h("div", null, nodes);
    });
  }

  /** Phần chỉ owner: cấu hình được bảo vệ + quản lý quản trị viên (đều tạo đề xuất chờ người khác duyệt). */
  function protectedSection(s) {
    const proposed = (res) => toast(`Đã tạo đề xuất #${res.changeId}: cần một quản trị viên KHÁC duyệt tại mục Chờ duyệt thì mới có hiệu lực.`, "ok");

    // predicates (JSON)
    const pred = h("textarea", { class: "editor mono", spellcheck: "false", "aria-label": "predicates JSON" });
    pred.value = jsonText(s.protected.predicates || {});
    pred.style.minHeight = "220px";
    const predBtn = btn("Đề xuất thay đổi predicates", {
      kind: "primary",
      on: {
        click: () => {
          let v;
          try {
            v = JSON.parse(pred.value);
          } catch (e) {
            return toast(`JSON không hợp lệ: ${e.message}`);
          }
          if (!v || typeof v !== "object" || Array.isArray(v) || !Object.keys(v).length) return toast("predicates rỗng: sẽ thay bộ mặc định bằng tập rỗng và làm hỏng việc khớp. Hãy nhập đầy đủ bộ predicates.");
          if (!confirm("Đề xuất thay THẾ TOÀN BỘ predicates bằng nội dung này?")) return;
          run(predBtn, async () => proposed(await post("/api/protected/predicates", { value: v })));
        },
      },
    });

    // whitelist URL
    const wl = h("textarea", { class: "mono", "aria-label": "Danh sách hostname" });
    wl.value = (s.protected.url_whitelist_extra || []).join("\n");
    const wlBtn = btn("Đề xuất thay đổi danh sách", {
      kind: "primary",
      on: {
        click: () => {
          const list = wl.value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
          const bad = list.find((x) => !/^[a-z0-9.-]+$/i.test(x));
          if (bad) return toast(`Hostname không hợp lệ: ${bad} (chỉ chữ, số, dấu chấm, gạch ngang; không có https:// hay đường dẫn)`);
          run(wlBtn, async () => proposed(await post("/api/protected/url_whitelist_extra", { value: list })));
        },
      },
    });

    // quản trị viên
    const newId = h("input", { type: "text", inputmode: "numeric", placeholder: "Telegram ID" });
    const newRole = select([["admin", "admin"], ["viewer", "viewer"], ["owner", "owner"]], "admin");
    const addBtn = btn("Đề xuất thêm / đổi quyền", {
      kind: "primary",
      on: {
        click: () => {
          if (!/^\d{3,15}$/.test(newId.value.trim())) return toast("Telegram ID phải là số");
          run(addBtn, async () => {
            proposed(await post("/api/admins", { telegramId: Number(newId.value.trim()), role: newRole.value }));
            newId.value = "";
          });
        },
      },
    });

    return h(
      "div",
      null,
      h("h1", null, "Chỉ owner"),
      notice("warn", "Các thay đổi dưới đây KHÔNG có hiệu lực ngay: chúng tạo một đề xuất và cần người khác duyệt ở mục Chờ duyệt."),
      card(
        "Predicates (điều kiện dùng trong luật khớp)",
        h("p", { class: "hint" }, "Bản đang lưu (rỗng nghĩa là bot dùng bộ mặc định trong tệp cấu hình). Mỗi predicate có một trong: any, regex, all_of, image_type. Khi đặt, bộ này thay thế HOÀN TOÀN bộ mặc định."),
        pred,
        h("div", { class: "actions" }, predBtn),
      ),
      card("Hostname URL được phép thêm (url_whitelist_extra)", h("p", { class: "hint" }, "Mỗi dòng một hostname, vd. docs.example.com. Câu trả lời chỉ được chứa link tới các host được phép."), wl, h("div", { class: "actions" }, wlBtn)),
      card(
        "Quản trị viên",
        table(
          [
            { label: "Telegram ID", cell: (a) => String(a.telegram_id) },
            { label: "Tên", cell: (a) => a.name },
            { label: "Quyền", cell: (a) => badge(a.role, a.role === "owner" ? "ok" : a.role === "admin" ? "info" : "muted") },
            {
              label: "",
              cell: (a) =>
                btn("Đề xuất gỡ", {
                  small: true,
                  kind: "danger",
                  on: {
                    click: (ev) => {
                      if (!confirm(`Đề xuất gỡ quản trị viên ${a.telegram_id}?`)) return;
                      run(ev.currentTarget, async () => proposed(await del(`/api/admins/${enc(a.telegram_id)}`)));
                    },
                  },
                }),
            },
          ],
          s.admins,
        ),
        h("hr", { class: "sep" }),
        h("div", { class: "form-row" }, field("Telegram ID", newId), field("Quyền", newRole), h("div", { class: "actions" }, addBtn)),
      ),
    );
  }

  // ---------------------------------------------------------------- 10. Usage
  function viewUsage({ query }) {
    return lazy(async () => {
      const from = query.get("from");
      const to = query.get("to");
      const u = await get("/api/usage", { from, to });
      const t = u.totals;
      const exp = (fmt) => `/api/usage/export${qs({ format: fmt, from: u.range.from, to: u.range.to })}`;
      const dayChart = columnChart(u.perDay.map((d) => ({ label: d.day.slice(5), value: d.totalTokens, title: `${d.day}: ${fmtNum(d.totalTokens)} token · ${fmtNum(d.requests)} yêu cầu · ${fmtCost(d.cost)}` })));
      return h(
        "div",
        null,
        pageHead("Usage (LLM)"),
        rangeForm(u.range),
        can("admin") ? h("div", { class: "actions" }, h("a", { class: "btn", href: exp("csv") }, "Tải CSV"), h("a", { class: "btn", href: exp("md") }, "Tải Markdown")) : null,
        h(
          "div",
          { class: "grid stats" },
          stat("Yêu cầu LLM", fmtNum(t.requests)),
          stat("Tổng token", fmtNum(t.totalTokens), `vào ${fmtNum(t.input)} · ra ${fmtNum(t.output)}`),
          stat("Cache", fmtNum(t.cacheRead + t.cacheWrite), `đọc ${fmtNum(t.cacheRead)} · ghi ${fmtNum(t.cacheWrite)}`),
          stat("Chi phí", fmtCost(t.cost)),
          stat("Người dùng", fmtNum(t.uniqueUsers), "khác nhau"),
        ),
        card("Token theo ngày", dayChart),
        card(
          "Chi tiết theo ngày",
          table(
            [
              { label: "Ngày", cell: (d) => link(d.day, `/usage?from=${d.day}&to=${d.day}`), cls: "nowrap" },
              { label: "Người dùng", cell: (d) => fmtNum(d.uniqueUsers), cls: "num" },
              { label: "Yêu cầu", cell: (d) => fmtNum(d.requests), cls: "num" },
              { label: "Vào", cell: (d) => fmtNum(d.input), cls: "num" },
              { label: "Ra", cell: (d) => fmtNum(d.output), cls: "num" },
              { label: "Cache", cell: (d) => fmtNum(d.cacheRead + d.cacheWrite), cls: "num" },
              { label: "Tổng token", cell: (d) => fmtNum(d.totalTokens), cls: "num" },
              { label: "Chi phí", cell: (d) => fmtCost(d.cost), cls: "num" },
            ],
            u.perDay,
            { empty: "Không có dữ liệu trong khoảng này" },
          ),
        ),
        u.hourly
          ? card(
              `Theo giờ (${u.range.from})`,
              columnChart(u.hourly.map((x) => ({ label: x.hour, value: x.tokens, title: `${x.hour}h: ${fmtNum(x.tokens)} token · ${fmtNum(x.requests)} yêu cầu` }))),
              table(
                [
                  { label: "Giờ", cell: (x) => `${x.hour}:00` },
                  { label: "Yêu cầu", cell: (x) => fmtNum(x.requests), cls: "num" },
                  { label: "Token", cell: (x) => fmtNum(x.tokens), cls: "num" },
                ],
                u.hourly,
                { empty: "Không có dữ liệu" },
              ),
            )
          : null,
        card(
          "Người dùng dùng nhiều token nhất",
          bars(u.topUsers.map((x) => ({ label: `${[x.name, x.username ? `@${x.username}` : null].filter(Boolean).join(" ") || "(chưa rõ tên)"} · ${x.userId}`, value: x.totalTokens, text: `${fmtNum(x.totalTokens)} token · ${fmtNum(x.requests)} yc` })), { empty: "Không có dữ liệu" }),
        ),
      );
    });
  }

  // ---------------------------------------------------------------- 11. Bộ câu hỏi mẫu
  function viewEval() {
    return lazy(async (reload) => {
      const [c, tpl] = await Promise.all([get("/api/eval/cases"), get("/api/templates").catch(() => null)]);
      const admin = can("admin");
      const result = h("div");
      const runBtn = btn("Chạy bộ câu hỏi mẫu", {
        kind: "primary",
        on: {
          click: () =>
            run(runBtn, async () => {
              clear(result);
              const r = await post("/api/eval/run", {});
              result.append(
                card(
                  "Kết quả chạy",
                  bars([{ label: `${fmtNum(r.correct)} / ${fmtNum(r.total)} đúng`, value: r.accuracy || 0, text: fmtPct(r.accuracy), tone: r.accuracy === 1 ? "ok" : r.accuracy != null && r.accuracy < 0.9 ? "err" : "warn" }]),
                  r.failures.length
                    ? table(
                        [
                          { label: "Câu hỏi", cell: (f) => f.question },
                          { label: "Kỳ vọng", cell: (f) => chip(f.expected) },
                          { label: "Bot chọn", cell: (f) => chip(f.got, "chip-err") },
                        ],
                        r.failures,
                      )
                    : h("p", { class: "muted" }, r.total ? "Tất cả câu đều đúng." : "Chưa có câu mẫu nào."),
                ),
              );
            }),
        },
      });

      let form = null;
      if (admin) {
        const q = h("input", { type: "text", maxlength: 500, placeholder: "Câu hỏi của khách" });
        const exp = h("input", { type: "text", list: "eval-tpl-ids", placeholder: "Template id kỳ vọng (để trống = ESCALATE)" });
        const dlist = h("datalist", { id: "eval-tpl-ids" }, (tpl ? tpl.items : []).map((t) => h("option", { value: t.id })));
        const img = select([["", "Không ảnh"], ["kyc_email", "kyc_email"], ["kyc_queue_screen", "kyc_queue_screen"], ["error_dialog", "error_dialog"], ["app_screen", "app_screen"], ["unrelated", "unrelated"]], "");
        const add = btn("Thêm", {
          kind: "primary",
          on: {
            click: () => {
              if (q.value.trim().length < 2) return toast("Câu hỏi quá ngắn");
              run(add, async () => {
                await post("/api/eval/cases", { question: q.value.trim(), expected: exp.value.trim() || null, image_type: img.value || null });
                reload();
              }, "Đã thêm câu mẫu");
            },
          },
        });
        form = card("Thêm câu mẫu", h("div", { class: "form-row" }, field("Câu hỏi", q), field("Kỳ vọng", exp), field("Ảnh", img), h("div", { class: "actions" }, add)), dlist);
      }

      const search = h("input", { type: "search", placeholder: "Lọc câu mẫu..." });
      const holder = h("div");
      let limit = 200;
      const draw = () => {
        const s = search.value.trim().toLowerCase();
        const rows = c.items.filter((x) => !s || x.question.toLowerCase().includes(s) || String(x.expected_template_id || "").toLowerCase().includes(s));
        clear(holder);
        holder.append(
          h("p", { class: "hint" }, `${fmtNum(rows.length)} / ${fmtNum(c.items.length)} câu`),
          table(
            [
              { label: "ID", cell: (x) => x.id, cls: "num" },
              { label: "Câu hỏi", cell: (x) => x.question },
              { label: "Kỳ vọng", cell: (x) => chip(x.expected_template_id || "ESCALATE") },
              { label: "Ảnh", cell: (x) => x.image_type },
              { label: "Nguồn", cell: (x) => x.source },
              {
                label: "",
                cell: (x) =>
                  admin
                    ? btn("Xoá", {
                        small: true,
                        kind: "danger",
                        on: {
                          click: (ev) => {
                            if (!confirm(`Xoá câu mẫu #${x.id}?`)) return;
                            run(ev.currentTarget, async () => {
                              await del(`/api/eval/cases/${x.id}`);
                              reload();
                            }, "Đã xoá");
                          },
                        },
                      })
                    : null,
              },
            ],
            rows.slice(0, limit),
          ),
          rows.length > limit ? btn("Hiện thêm", { on: { click: () => ((limit += 200), draw()) } }) : null,
        );
      };
      search.addEventListener("input", draw);
      draw();

      return h("div", null, pageHead("Bộ câu hỏi mẫu"), notice("info", "Bộ câu mẫu dùng để kiểm tra hồi quy trước khi Publish. Chạy chỉ dùng tầng 0-1 (không tốn token)."), h("div", { class: "actions" }, runBtn), result, form, h("div", { class: "form-row" }, h("div", { class: "field" }, search)), card(null, holder));
    });
  }

  // ---------------------------------------------------------------- 12. Nhật ký
  function viewAudit({ query }) {
    const LIMIT = 50;
    return h(
      "div",
      null,
      pageHead("Nhật ký thao tác"),
      lazy(async () => {
        const r = await get("/api/audit", { limit: LIMIT, offset: query.get("offset") || 0 });
        return h(
          "div",
          null,
          card(
            null,
            table(
              [
                { label: "Thời gian", cell: (a) => fmtDate(a.at), cls: "nowrap" },
                { label: "Ai", cell: (a) => a.actor },
                { label: "Hành động", cell: (a) => chip(a.action) },
                { label: "Đối tượng", cell: (a) => a.entity },
                { label: "Chi tiết", cell: (a) => (a.before == null && a.after == null ? "-" : h("details", null, h("summary", null, "xem"), a.before != null ? h("div", null, h("div", { class: "hint" }, "Trước"), jsonBlock(a.before)) : null, a.after != null ? h("div", null, h("div", { class: "hint" }, "Sau"), jsonBlock(a.after)) : null)) },
              ],
              r.items,
              { empty: "Chưa có nhật ký" },
            ),
          ),
          pager(query, LIMIT, r.items.length),
        );
      }),
    );
  }

  // ---------------------------------------------------------------- 13. Thông báo hàng loạt (owner)
  function viewBroadcasts() {
    const text = h("textarea", { maxlength: 3500, placeholder: "Nội dung gửi tới TẤT CẢ người dùng (tối đa 3500 ký tự)" });
    const confirmBox = h("div");
    const listBox = h("div");

    /** Bước xác nhận: owner phải gõ đúng số người nhận. */
    const showConfirm = (bc, reloadList) => {
      clear(confirmBox);
      const typed = h("input", { type: "text", inputmode: "numeric", autocomplete: "off", placeholder: `Gõ ${bc.total} để xác nhận` });
      const send = btn(`Gửi cho ${fmtNum(bc.total)} người`, { kind: "danger", disabled: true });
      typed.addEventListener("input", () => (send.disabled = typed.value.trim() !== String(bc.total)));
      send.addEventListener("click", () => {
        if (typed.value.trim() !== String(bc.total)) return;
        run(send, async () => {
          await post(`/api/broadcasts/${bc.id}/send`, { confirmTotal: Number(typed.value.trim()) });
          clear(confirmBox);
          text.value = "";
          reloadList();
        }, "Đã đưa vào hàng đợi gửi");
      });
      confirmBox.append(
        card(
          `Xác nhận gửi thông báo #${bc.id}`,
          notice("warn", `Thông báo sẽ được gửi tới ${fmtNum(bc.total)} người dùng và KHÔNG thể thu hồi. Để xác nhận, hãy gõ chính xác số người nhận: ${bc.total}.`),
          h("div", { class: "pre-wrap" }, bc.text),
          h("div", { class: "form-row" }, field("Số người nhận", typed), h("div", { class: "actions" }, send, btn("Huỷ", { on: { click: () => clear(confirmBox) } }))),
        ),
      );
      confirmBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
    };

    let reloadList = () => {};
    const list = lazy(async (reload) => {
      reloadList = reload;
      const r = await get("/api/broadcasts");
      // mỗi bản nháp có nút "Xác nhận gửi" để tiếp tục bước xác nhận
      return table(
        [
          { label: "ID", cell: (b) => b.id, cls: "num" },
          { label: "Trạng thái", cell: (b) => statusBadge(b.status) },
          { label: "Nhận / gửi / lỗi", cell: (b) => `${fmtNum(b.total)} / ${fmtNum(b.sent)} / ${fmtNum(b.failed)}`, cls: "nowrap" },
          { label: "Tạo", cell: (b) => fmtDate(b.created_at), cls: "nowrap" },
          { label: "Xong", cell: (b) => (b.finished_at ? fmtDate(b.finished_at) : "-"), cls: "nowrap" },
          { label: "Nội dung", cell: (b) => h("details", null, h("summary", null, short(b.text, 60)), h("div", { class: "pre-wrap" }, b.text)) },
          { label: "", cell: (b) => (b.status === "draft" ? btn("Xác nhận gửi", { small: true, on: { click: () => showConfirm(b, reload) } }) : b.status === "sending" ? btn("Làm mới", { small: true, on: { click: reload } }) : null) },
        ],
        r.items,
        { empty: "Chưa có thông báo nào" },
      );
    });
    listBox.append(list);

    const create = btn("Tạo bản nháp", {
      kind: "primary",
      on: {
        click: () => {
          if (!text.value.trim()) return toast("Hãy nhập nội dung");
          run(create, async () => {
            const r = await post("/api/broadcasts", { text: text.value });
            toast(`Đã tạo bản nháp #${r.id}: sẽ gửi tới ${fmtNum(r.total)} người. Cần xác nhận trước khi gửi.`, "ok");
            showConfirm({ id: r.id, total: r.total, text: text.value }, () => reloadList());
            reloadList();
          });
        },
      },
    });

    return h(
      "div",
      null,
      pageHead("Thông báo hàng loạt"),
      notice("warn", "Thông báo được gửi cho tất cả người dùng của bot. Tạo bản nháp trước để thấy số người nhận, sau đó gõ lại đúng số đó để xác nhận gửi."),
      card("Soạn thông báo", field("Nội dung", text), h("div", { class: "actions" }, create)),
      confirmBox,
      card("Các thông báo đã tạo", listBox),
    );
  }

  // ==================================================================================================
  // 6. Khởi động
  // ==================================================================================================

  window.addEventListener("hashchange", () => {
    if (state.me) render();
  });

  (async () => {
    try {
      await startSession();
    } catch (e) {
      if (e && e.status === 401) showLogin();
      else {
        $("app").replaceChildren(errorBox(e, () => location.reload()));
      }
    }
  })();
})();
