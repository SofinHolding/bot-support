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
  /** YYYY-MM-DD -> DD/MM (đủ để nhận ra khoảng ngày đang xem). */
  const dm = (iso) => (/^\d{4}-\d{2}-\d{2}$/.test(iso || "") ? `${iso.slice(8)}/${iso.slice(5, 7)}` : String(iso ?? ""));
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
  const TIER = { "-1": "Không xác định", 0: "Tầng 0: luật", 1: "Tầng 1: từ khoá và ngữ nghĩa", 2: "Tầng 2: LLM", 3: "Tầng 3: tri thức" };
  const TIER_COST = { 0: "Luật cố định, không tốn token", 1: "Khớp từ khoá và ngữ nghĩa, không tốn token", 2: "LLM nhỏ chọn template", 3: "LLM kèm tri thức, tốn token nhất" };
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

  /**
   * Ô nhập có gợi ý thả xuống, tự vẽ bằng CSS của trang thay vì `<input list>` + `<datalist>` của trình duyệt
   * (popup gợi ý mặc định không style được và có màu lệch hẳn giao diện, tối trên một số trình duyệt/hệ điều hành).
   * `opts.options`: mảng `{value,label}` (hoặc chuỗi), hoặc hàm trả về mảng đó (đồng bộ hoặc Promise), gọi một lần lúc tạo.
   * Trả về `div.combo` (chèn thẳng vào DOM như input cũ) chứa cả ô nhập lẫn menu gợi ý; đọc/ghi `.value` như input bình thường.
   */
  function combobox(opts = {}) {
    const input = h("input", { type: "text", value: opts.value || "", placeholder: opts.placeholder || "", autocomplete: "off", spellcheck: "false" });
    const menu = h("div", { class: "combo-menu", hidden: true });
    const wrap = h("div", { class: "combo" }, input, menu);
    let items = [];
    let active = -1;

    const setActive = (i) => {
      active = i;
      [...menu.children].forEach((el, idx) => el.classList.toggle("active", idx === active));
      if (active >= 0) menu.children[active].scrollIntoView({ block: "nearest" });
    };
    const pick = (it) => {
      input.value = it.value;
      menu.hidden = true;
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const matches = (q ? items.filter((it) => it.value.toLowerCase().includes(q) || it.label.toLowerCase().includes(q)) : items).slice(0, 50);
      clear(menu);
      active = -1;
      if (!matches.length) {
        menu.hidden = true;
        return;
      }
      for (const it of matches) menu.append(h("div", { class: "combo-opt", on: { mousedown: (ev) => (ev.preventDefault(), pick(it)) } }, it.value, it.label && it.label !== it.value ? h("span", { class: "combo-opt-sub" }, it.label) : null));
      menu.hidden = false;
    };
    input.addEventListener("input", render);
    input.addEventListener("focus", render);
    input.addEventListener("keydown", (ev) => {
      if (menu.hidden || !menu.children.length) return;
      if (ev.key === "ArrowDown") {
        ev.preventDefault();
        setActive(Math.min(active + 1, menu.children.length - 1));
      } else if (ev.key === "ArrowUp") {
        ev.preventDefault();
        setActive(Math.max(active - 1, 0));
      } else if (ev.key === "Enter" && active >= 0) {
        ev.preventDefault();
        menu.children[active].dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      } else if (ev.key === "Escape") menu.hidden = true;
    });
    document.addEventListener("click", (ev) => {
      if (!wrap.contains(ev.target)) menu.hidden = true;
    });

    Promise.resolve(typeof opts.options === "function" ? opts.options() : opts.options)
      .then((r) => (items = (r || []).map((x) => (typeof x === "string" ? { value: x, label: "" } : x))))
      .catch(() => undefined);

    // Nơi gọi vẫn đọc/ghi .value như một input bình thường; phần tử thật chèn vào DOM là wrap (input + menu gợi ý).
    Object.defineProperty(wrap, "value", { get: () => input.value, set: (v) => (input.value = v) });
    return wrap;
  }

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

  /** Dải ngang cho thấy các tin dừng ở tầng nào: xanh thông (miễn phí) sang đất nung (tốn token nhất). */
  function tierRail(rows, total) {
    if (!rows.length || !total) return emptyBox("Chưa có quyết định nào trong khoảng này");
    const sorted = [...rows].sort((a, b) => a.tier - b.tier);
    const track = h("div", { class: "tier-track", role: "img", "aria-label": sorted.map((r) => tierLabel(r.tier) + ": " + fmtNum(r.n)).join(", ") });
    const legend = h("ul", { class: "tier-legend" });
    for (const r of sorted) {
      const cls = r.tier >= 0 && r.tier <= 3 ? "t" + r.tier : "tx";
      const seg = h("span", { class: "seg " + cls, title: tierLabel(r.tier) + ": " + fmtNum(r.n) });
      seg.style.width = ((r.n / total) * 100).toFixed(2) + "%";
      track.append(seg);
      legend.append(h("li", null, h("span", { class: "sw " + cls }), h("div", null, h("b", null, tierLabel(r.tier)), h("div", { class: "n" }, fmtNum(r.n), h("small", null, fmtPct(r.n / total, 0))), h("div", { class: "cost" }, TIER_COST[r.tier] || ""))));
    }
    return h("div", { class: "tier-rail" }, track, legend);
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
  /** Tải một tệp lên (multipart) — cùng cách xử lý lỗi/401 như api(), nhưng KHÔNG tự đặt content-type để trình duyệt tự thêm boundary. */
  async function uploadFile(path, file) {
    const form = new FormData();
    form.append("file", file, file.name);
    let res;
    try {
      res = await fetch(path, { method: "POST", credentials: "same-origin", headers: { accept: "application/json", "x-requested-with": "admin-web" }, body: form });
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
      const err = new ApiError(res.status, (data && typeof data.error === "string" && data.error) || `Lỗi ${res.status}`);
      if (res.status === 401) {
        err.handled = true;
        onUnauthorized();
      }
      throw err;
    }
    return data;
  }

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
    document.body.classList.remove("in-app", "nav-open");
    $("footer").textContent = "";
    const box = h("div", { class: "card" });
    const wrap = h(
      "div",
      { class: "login-shell" },
      h(
        "section",
        { class: "login-brand" },
        document.querySelector(".rail .brand").cloneNode(true),
        h(
          "div",
          null,
          h("h2", null, "Xem bot đã trả lời gì, và vì sao."),
          h("p", null, "Đăng nhập bằng Telegram, không cần mật khẩu."),
          h("ol", { class: "login-steps" }, h("li", null, "Nhập Telegram ID của bạn."), h("li", null, "Mở Telegram: bot gửi mã 6 chữ số."), h("li", null, "Nhập mã để vào trang quản trị.")),
        ),
        h("p", { class: "small" }, "Chỉ quản trị viên được cấp quyền mới đăng nhập được."),
      ),
      h("section", { class: "login-panel" }, box),
    );
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
        flash ? notice("warn", flash) : document.createDocumentFragment(),
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
    { path: "usage", label: "Chi phí LLM", view: viewUsage },
    { path: "eval", label: "Câu hỏi mẫu", view: viewEval },
    { path: "audit", label: "Nhật ký", view: viewAudit, min: "admin" },
    { path: "broadcasts", label: "Thông báo hàng loạt", view: viewBroadcasts, min: "owner" },
  ];

  const SVG_NS = "http://www.w3.org/2000/svg";
  const ICONS = {
    dashboard: ["M4 13h6V4H4z", "M14 20h6v-9h-6z", "M14 4h6v4h-6z", "M4 17h6v3H4z"],
    conversations: ["M4 5h16v11H9l-5 4z"],
    users: ["M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z", "M4 20c0-4 3.5-6 8-6s8 2 8 6"],
    tickets: ["M4 6h16v3a2.5 2.5 0 0 0 0 6v3H4v-3a2.5 2.5 0 0 0 0-6z", "M14 6v12"],
    kb: ["M5 4h11a3 3 0 0 1 3 3v13H8a3 3 0 0 1-3-3z", "M5 17a3 3 0 0 1 3-3h11"],
    translations: ["M4 6h9", "M8.5 4v2", "M6 6c0 4 3 7 7 8", "M11 6c-.5 3-3 6-7 8", "M14 20l4-9 4 9", "M15.5 17h5"],
    eval: ["M9 5h11", "M9 12h11", "M9 19h11", "M4 5l1 1 2-2", "M4 12l1 1 2-2", "M4 19l1 1 2-2"],
    changes: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M8 12l3 3 5-6"],
    settings: ["M4 7h10", "M18 7h2", "M4 17h2", "M10 17h10", "M16 4v6", "M8 14v6"],
    usage: ["M5 20V10", "M12 20V4", "M19 20v-7"],
    audit: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
    broadcasts: ["M4 10v4h3l8 4V6L7 10z", "M18 9c1.5 1 1.5 5 0 6"],
  };
  function icon(name) {
    const svg = document.createElementNS(SVG_NS, "svg");
    for (const [k, v] of Object.entries({ viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true" })) svg.setAttribute(k, v);
    for (const d of ICONS[name] || []) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    return svg;
  }

  /** Mục điều hướng gom theo luồng việc của người hỗ trợ. */
  const NAV_GROUPS = [
    { label: null, items: ["dashboard"] },
    { label: "Hỗ trợ khách", items: ["conversations", "tickets", "users"] },
    { label: "Nội dung của bot", items: ["kb", "translations", "eval", "changes"] },
    { label: "Hệ thống", items: ["settings", "usage", "audit", "broadcasts"] },
  ];

  const THEMES = [["auto", "◐ Theo máy"], ["light", "☀ Sáng"], ["dark", "☾ Tối"]];
  const applyTheme = (t) => {
    if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  };
  applyTheme(readLS("admin_theme"));

  const closeNav = () => {
    document.body.classList.remove("nav-open");
    const b = $("menu-btn");
    if (b) b.setAttribute("aria-expanded", "false");
  };

  function buildChrome() {
    document.body.classList.add("in-app");
    $("topbar").hidden = false;

    const me = state.me;
    const who = $("who");
    clear(who);
    const initial = (me.name || "A").trim().charAt(0).toUpperCase();
    const themeBtn = btn("", { small: true, title: "Đổi giao diện sáng/tối" });
    const setThemeLabel = () => {
      const cur = readLS("admin_theme") || "auto";
      themeBtn.textContent = THEMES.find((t) => t[0] === cur)[1];
    };
    themeBtn.addEventListener("click", () => {
      const cur = readLS("admin_theme") || "auto";
      const next = THEMES[(THEMES.findIndex((t) => t[0] === cur) + 1) % THEMES.length][0];
      writeLS("admin_theme", next);
      applyTheme(next);
      setThemeLabel();
    });
    setThemeLabel();
    who.append(
      h("div", { class: "who-name" }, h("div", { class: "avatar", "aria-hidden": "true" }, initial), h("div", null, h("b", null, me.name || "Quản trị viên"), h("span", null, me.role + " · #" + me.id))),
      h("div", { class: "who-tools" }, themeBtn, btn("Đăng xuất", { small: true, on: { click: logout } })),
    );

    const nav = $("nav");
    clear(nav);
    for (const g of NAV_GROUPS) {
      const items = g.items.map((p) => ROUTES.find((r) => r.path === p)).filter((r) => r && (!r.min || can(r.min)));
      if (!items.length) continue;
      nav.append(
        h(
          "div",
          { class: "nav-group" },
          g.label ? h("h2", null, g.label) : null,
          items.map((r) => h("a", { href: "#/" + r.path, "data-route": r.path }, icon(r.path), h("span", null, r.label), r.path === "changes" ? h("span", { class: "count", id: "pending-count", hidden: true }) : null)),
        ),
      );
    }
    $("menu-btn").onclick = () => {
      const open = !document.body.classList.contains("nav-open");
      document.body.classList.toggle("nav-open", open);
      $("menu-btn").setAttribute("aria-expanded", String(open));
    };
    $("scrim").onclick = closeNav;
  }

  /** Số thay đổi đang chờ duyệt hiện cạnh mục "Chờ duyệt" để không phải mở từng trang mới biết. */
  async function refreshPending() {
    const el = $("pending-count");
    if (!el) return;
    try {
      const r = await get("/api/changes", { status: "pending" }, { quiet401: true });
      const n = r.items.length;
      el.textContent = String(n);
      el.hidden = n === 0;
    } catch {
      /* chỉ là chỉ báo, không quan trọng */
    }
  }

  function markNav(name) {
    for (const a of $("nav").querySelectorAll("a")) {
      const on = a.getAttribute("data-route") === name;
      a.classList.toggle("active", on);
      if (on) a.setAttribute("aria-current", "page");
      else a.removeAttribute("aria-current");
    }
  }

  function render() {
    if (!state.me) return;
    const { parts, query } = parseHash();
    const name = parts[0] || "dashboard";
    const route = ROUTES.find((r) => r.path === name);
    markNav(name);
    closeNav();
    refreshPending();
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

  const PAGE_HINT = {
    "Tổng quan": "Bot đã xử lý gì trong khoảng ngày đã chọn, và chỗ nào cần bạn can thiệp.",
    "Hội thoại": "Xem từng cuộc trò chuyện và lý do bot trả lời như vậy.",
    "Người dùng": "Những khách đã nhắn cho bot, kèm ngôn ngữ và số lần nhắn.",
    "Ticket": "Các ca bot đã chuyển cho người hỗ trợ: phân người phụ trách, ghi chú và cập nhật trạng thái.",
    "Kho tri thức": "Template, tài liệu tri thức và Hướng dẫn AI làm việc. Sửa ở bản nháp, kiểm tra rồi mới Publish.",
    "Bản dịch": "Duyệt bản dịch template do LLM tạo trước khi khách nhận được.",
    "Chờ duyệt": "Thay đổi nhạy cảm cần một người khác duyệt trước khi có hiệu lực.",
    "Cấu hình": "Mô hình LLM, ngưỡng và giới hạn của bot. Thay đổi có hiệu lực không cần khởi động lại.",
    "Chi phí LLM": "Token và chi phí theo ngày, theo mục đích và theo khách.",
    "Bộ câu hỏi mẫu": "Câu hỏi có đáp án đúng để kiểm tra bot trước khi Publish.",
    "Nhật ký thao tác": "Ai đã sửa gì, khi nào, giá trị trước và sau.",
    "Thông báo hàng loạt": "Gửi một tin tới nhiều khách. Cần xác nhận số người nhận trước khi gửi.",
  };
  const pageHead = (title, ...extra) => h("div", { class: "page-top" }, h("div", { class: "page-head" }, h("h1", null, title), extra), PAGE_HINT[title] ? h("p", { class: "page-sub" }, PAGE_HINT[title]) : null);

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
          stat("Tin nhắn khách", fmtNum(d.totals.messages), `${dm(d.range.from)} đến ${dm(d.range.to)}`),
          stat("Người dùng", fmtNum(d.totals.users), "khách có gửi tin"),
          stat("Quyết định của bot", fmtNum(total)),
          stat("Tỉ lệ chuyển support", fmtPct(d.rates.escalateRate), "ESCALATE / quyết định"),
          stat("Tỉ lệ không dùng LLM", fmtPct(d.rates.zeroLlmRate), "tầng 0-1: 0 token"),
        ),
        card("Mỗi tin dừng ở tầng nào", h("p", { class: "muted" }, "Càng sang phải, bot càng phải nhờ LLM và càng tốn token."), tierRail(d.byTier, total)),
        h("div", { class: "grid grid-2" }, card("Theo loại quyết định", bars(kindItems)), card("Số lần chuyển support theo ngày", bars(d.escalationsByDay.map((e) => ({ label: e.day, value: e.n, tone: "warn" }))))),
        card("Template được dùng nhiều nhất", bars(d.topTemplates.map((t) => ({ label: t.templateId, value: t.n })))),
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
  const SUMMARY_LABEL = { issue: "Vấn đề", user_reported: "Khách báo", unresolved_points: "Điểm còn treo", exact_facts: "Giá trị khách nêu (nguyên văn)", degraded: "Bản dự phòng (LLM lỗi)", model_note: "Ghi chú" };
  const summaryValue = (v) => (typeof v === "string" ? v : Array.isArray(v) ? v.join(" · ") || "-" : v === true ? "có" : jsonText(v));

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

      const summary = ep.summary && typeof ep.summary === "object" ? dl(Object.entries(ep.summary).map(([k, v]) => [SUMMARY_LABEL[k] || k, summaryValue(v)])) : h("span", { class: "muted" }, "Chưa có tóm tắt (tạo khi hội thoại đủ dài và có LLM).");

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
          if (notes.value !== (t.notes || "")) {
            b.notes = notes.value;
            b.notes_base = t.notes ?? null;
          }
          if ((b.pic === "" && t.pic) || (b.notes === "" && t.notes)) return toast("Máy chủ chưa hỗ trợ xoá trắng PIC/ghi chú (giữ giá trị cũ khi để trống).");
          if (b.pic === "") delete b.pic;
          if (b.notes === "") {
            delete b.notes;
            delete b.notes_base;
          }
          if (!Object.keys(b).length) return toast("Không có thay đổi để lưu", "info");
          run(save, async () => {
            await patch(`/api/tickets/${t.id}`, b);
            if (b.pic != null) t.pic = b.pic;
            if (b.notes != null) t.notes = b.notes;
          }, "Đã lưu");
        },
      },
    });
    return h("div", { class: "row-card ticket" }, h("div", { class: "ticket-info" }, head, meta, body), h("div", { class: "ticket-work" }, h("div", { class: "form-row" }, h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Trạng thái"), status), h("div", { class: "field" }, h("span", { class: "lbl" }, "PIC"), pic)), h("div", { class: "field" }, h("span", { class: "lbl" }, "Ghi chú"), notes), save));
  }

  // ---------------------------------------------------------------- 6. Kho tri thức
  const KB_TABS = [["Tài liệu", "/kb"], ["Hướng dẫn AI làm việc", "/kb/guide"], ["SKILL AI", "/kb/skills"], ["Template", "/kb/templates"]];
  const GUIDE_SLUG = "agent-guide";
  const KIND_BADGE = { templates: ["template", "info"], knowledge: ["tri thức", "muted"], guide: ["hướng dẫn AI", "warn"] };
  const docKindBadge = (k) => badge((KIND_BADGE[k] || [k, "muted"])[0], (KIND_BADGE[k] || [k, "muted"])[1]);

  function viewKb({ parts, query }) {
    const [sub, arg] = parts;
    const active = sub === "templates" || sub === "guide" || sub === "skills" ? `/kb/${sub}` : sub === "doc" && arg === GUIDE_SLUG ? "/kb/guide" : "/kb";
    const tabs = h("nav", { class: "tabs" }, KB_TABS.map(([label, path]) => h("a", { href: `#${path}`, class: path === active ? "active" : null }, label)));
    let body;
    if (sub === "templates") body = kbTemplates();
    else if (sub === "guide") body = kbGuide();
    else if (sub === "skills") body = kbSkills();
    else if (sub === "intake" && arg) body = kbIntakeReview(arg);
    else if (sub === "intake") body = kbIntakeNew();
    else if (sub === "doc" && arg) body = kbDoc(arg);
    else if (sub === "new") body = kbEditorNew(query);
    else if (sub === "edit" && arg) body = kbEditorEdit(arg);
    else body = kbDocs();
    return h("div", null, pageHead("Kho tri thức"), kbSearchBar(), tabs, body);
  }

  /** Tìm xuyên suốt kho: tài liệu, đoạn tri thức đang publish, template — dù đang ở tab nào. Kết quả bấm vào là mở đúng chỗ. */
  const KB_SEARCH_TYPE = { template: ["template", "info"], chunk: ["đoạn tri thức", "muted"], doc: ["tài liệu", "muted"] };
  function kbSearchBar() {
    const input = h("input", { type: "search", placeholder: "Tìm id template, từ khoá, hoặc nội dung — vd. esc-login-fail, wallet creation failed..." });
    const holder = h("div", { class: "search-results" });
    let timer = null;
    let seq = 0;
    const openHit = (it) => {
      if (it.type === "template") {
        if (!it.docSlug) return toast("Template này chưa nằm trong tài liệu đang publish", "info");
        editTemplate(it.docSlug, it.id);
      } else if (it.docSlug) go(`/kb/doc/${enc(it.docSlug)}`);
    };
    const draw = async () => {
      const q = input.value.trim();
      const my = ++seq;
      if (q.length < 2) {
        clear(holder);
        return;
      }
      let r;
      try {
        r = await get("/api/kb/search", { q });
      } catch {
        return;
      }
      if (my !== seq) return; // kết quả của lần gõ trước, đến muộn: bỏ
      clear(holder);
      if (!r.items.length) {
        holder.append(h("p", { class: "muted" }, "Không tìm thấy."));
        return;
      }
      holder.append(
        h(
          "div",
          { class: "list" },
          r.items.map((it) => {
            const tag = KB_SEARCH_TYPE[it.type] || [it.type, "muted"];
            return h(
              "div",
              { class: "row-card row-card-clickable", on: { click: () => openHit(it) } },
              h("div", { class: "row-top" }, badge(tag[0], tag[1]), it.type === "template" ? h("code", null, it.id) : h("b", null, it.title), it.docSlug ? h("span", { class: "muted small" }, "trong tài liệu ", h("code", null, it.docSlug)) : null),
              it.snippet ? h("div", { class: "hint pre-wrap" }, short(it.snippet, 160)) : null,
            );
          }),
        ),
      );
    };
    input.addEventListener("input", () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(draw, 250);
    });
    return card(null, h("div", { class: "field" }, input), holder);
  }

  function kbDocs() {
    return lazy(async () => {
      const r = await get("/api/kb/documents");
      noteKb(r.kbVersion);
      return h(
        "div",
        null,
        can("admin")
          ? h(
              "div",
              { class: "actions" },
              link("+ Nạp nội dung mới", "/kb/intake", "btn btn-primary"),
              link("+ Tài liệu mới (tự viết cấu trúc)", "/kb/new", "btn"),
              h("span", { class: "hint" }, "Không rành cấu trúc YAML, hoặc chưa cấu hình LLM? Dùng \"Nạp nội dung mới\" — hệ thống tự phân loại và dựng đúng cấu trúc. Tự viết chỉ cần khi cần các trường nâng cao (follow_up, ticket, luật bảo mật, nhiều ngôn ngữ...)."),
            )
          : null,
        card(
          null,
          table(
            [
              { label: "Slug", cell: (d) => link(d.slug, `/kb/doc/${enc(d.slug)}`) },
              { label: "Tiêu đề", cell: (d) => d.title },
              { label: "Loại", cell: (d) => docKindBadge(d.kind) },
              { label: "Đang chạy", cell: (d) => (d.published_version ? badge(`v${d.published_version}`, "ok") : badge("chưa publish", "warn")) },
              { label: "Mới nhất", cell: (d) => `v${d.latest_version}` },
              {
                label: "Xung đột",
                cell: (d) =>
                  d.conflicts
                    ? h("a", { href: `#/kb/doc/${enc(d.slug)}`, class: "conflict-dot", title: d.conflictHint || `${d.conflicts} xung đột đang mở` }, h("span", { class: "dot dot-err", "aria-hidden": "true" }), ` ${d.conflicts}`)
                    : null,
              },
              { label: "", cell: (d) => link("Các phiên bản", `/kb/doc/${enc(d.slug)}`) },
            ],
            r.items,
          ),
        ),
      );
    });
  }

  /** Giải thích ngắn cho người quản trị: tài liệu này tác động tới đâu, và tới đâu thì KHÔNG. */
  function guideIntro() {
    return notice(
      "info",
      "Tài liệu này cho AI biết bối cảnh, nhiệm vụ, cách giao tiếp, mục tiêu, giới hạn và quy trình làm việc. Bắt buộc đủ 6 mục \"## 1.\" đến \"## 6.\"; các mục khác chỉ dành cho người đọc. ",
      "Mỗi việc của AI chỉ nhận mục liên quan: phân loại tin nhắn (mục 1, 2, 5), xác nhận/trả lời tri thức (1, 3, 5), tóm tắt (1, 4), dịch (3). ",
      "Luật do code cưỡng chế (bảo mật, chống spam, kiểm tra đầu ra, ngôn ngữ) KHÔNG đổi được bằng tài liệu này, và bước kiểm tra sẽ chặn câu cho phép điều hệ thống cấm. ",
      "Mọi lần Publish cần một quản trị viên KHÁC duyệt tại mục Chờ duyệt.",
    );
  }

  const SKILL_LABEL = {
    understand: "Hiểu tin nhắn của khách (ngôn ngữ, ý định, câu truy vấn)",
    "select-answer": "Chọn câu trả lời đúng trong các ứng viên tìm được (nhánh AI/RAG)",
    "verify-answer": "Kiểm duyệt câu trả lời khớp bằng từ khoá (FAST PATH)",
    "translate-query": "Dịch câu hỏi sang ngôn ngữ của kho để tìm",
    "translate-answer": "Dịch câu trả lời sang ngôn ngữ của khách (template và tài liệu)",
    "review-eval": "Đánh giá bộ câu hỏi mẫu (chỉ dùng trên Admin Web)",
    "summarize-episode": "Tóm tắt cuộn một vụ việc (giữ mạch hội thoại; nguồn cho khối chuyển hỗ trợ)",
    "verify-handoff": "Kiểm khối tóm tắt chuyển hỗ trợ trước khi gửi khách",
    "review-overlap": "Phán xét cặp nội dung chồng lấn (Template → Quét chồng lấn)",
  };
  function kbSkills() {
    return lazy(async (reload) => {
      const r = await get("/api/skills");
      return h(
        "div",
        null,
        notice("info", "SKILL là chỉ dẫn gửi cho AI ở từng bước. Mỗi file gồm frontmatter (name, version, description), mục '## Requirements' với các yêu cầu R1, R2… và mục '## Output'. Sửa ở đây có hiệu lực cho bot trong vài giây" + (r.secondApproval ? " sau khi một quản trị viên khác duyệt (mục Chờ duyệt)." : ".") + " 'Về bản mặc định' quay lại file gốc của dự án. Lưu ý: luật do code cưỡng chế (kiểm số liệu, link, ngôn ngữ, chỉ được chọn trong danh sách) vẫn áp dụng dù SKILL viết gì."),
        h("div", { class: "list" }, r.items.map((sk) => {
          const ta = h("textarea", { class: "editor mono", spellcheck: "false", rows: 22, readonly: can("admin") ? null : true });
          ta.value = sk.markdown;
          const save = btn("Lưu", { kind: "primary", small: true, on: { click: () => run(save, async () => { const x = await put(`/api/skills/${enc(sk.name)}`, { markdown: ta.value }); toast(x.status === "pending_approval" ? "Đã gửi đề xuất: cần một quản trị viên khác duyệt ở mục Chờ duyệt." : "Đã lưu SKILL. Bot dùng bản mới trong vài giây.", "ok"); reload(); }) } });
          const reset = btn("Về bản mặc định", { small: true, disabled: sk.source !== "custom", on: { click: () => { if (!confirm(`Bỏ bản đã sửa của ${sk.name}, dùng lại file mặc định?`)) return; run(reset, async () => { await del(`/api/skills/${enc(sk.name)}`); reload(); }, "Đã quay về bản mặc định"); } } });
          return h("div", { class: "row-card" },
            h("div", { class: "row-top" }, h("code", null, sk.name), badge(`v${sk.version}`), sk.source === "custom" ? badge("đã sửa", "info") : badge("mặc định"), h("span", { class: "muted" }, SKILL_LABEL[sk.name] || "")),
            h("div", { class: "hint" }, sk.description),
            ta,
            can("admin") ? h("div", { class: "actions" }, save, reset) : null,
          );
        })),
      );
    });
  }

  function kbGuide() {
    return lazy(async () => {
      const r = await get("/api/kb/documents");
      if (r.items.some((d) => d.slug === GUIDE_SLUG)) return kbDoc(GUIDE_SLUG);
      return h(
        "div",
        null,
        guideIntro(),
        notice("warn", "Chưa có Hướng dẫn AI làm việc: AI đang chạy chỉ với các luật cố định của hệ thống."),
        can("admin") ? h("div", { class: "actions" }, link("Soạn hướng dẫn", `/kb/new?slug=${GUIDE_SLUG}&kind=guide&title=${enc("Hướng dẫn AI làm việc")}`, "btn btn-primary")) : null,
      );
    });
  }

  const CONFLICT_VERDICT = { duplicate: ["trùng", "err"], subset: ["bao hàm", "warn"], conflict: ["mâu thuẫn", "err"], distinct: ["khác nhau", "ok"] };
  /**
   * Thẻ "Xung đột nội dung" trên trang tài liệu: xung đột đã CHỐT lúc publish (kb_conflicts), không phải quét tạm thời.
   * Mỗi dòng là một cặp — bên nào không phải tài liệu đang xem thì có link mở; nếu code đã biết chính xác cụm khớp gây
   * xung đột (narrow) thì có nút "Áp dụng: gỡ ..." điền sẵn bản sửa để admin xem lại trước khi Publish.
   */
  function conflictsCard(slug, items, reload) {
    if (!items.length) return null;
    const otherSide = (p) => (p.a.doc === slug ? p.b : p.a);
    const ownSide = (p) => (p.a.doc === slug ? p.a : p.b);
    // Gợi ý AI (xem content/skills/review-overlap/SKILL.md) gọi tắt hai bên là "A"/"B" theo đúng thứ tự gửi cho AI
    // (p.a / p.b) — GIỮ đúng thứ tự đó khi gắn nhãn, dù cột hiển thị có thể đảo (ownSide luôn ở cột trái) để dễ đọc.
    const abLabel = (p, r) => (r === p.a ? "A" : "B");
    const refLine = (r, label) => h("div", null, label ? badge(label, "muted") : null, " ", badge(r.kind === "template" ? "template" : "đoạn tri thức", r.kind === "template" ? "info" : "muted"), " ", r.doc === slug ? h("code", null, r.id) : link(r.id, `/kb/doc/${enc(r.doc)}`, "mono"), r.doc !== slug ? h("span", { class: "muted small" }, " (", r.doc, ")") : null, h("div", { class: "small muted" }, r.title));
    return card(
      "⚠ Xung đột nội dung",
      h("p", { class: "muted" }, `Tài liệu này đã được publish dù bước kiểm tra cảnh báo chồng lấn với nội dung khác — bot có thể chọn nhầm bên kia khi khách hỏi. ${fmtNum(items.length)} cặp đang mở.`),
      h(
        "div",
        { class: "list" },
        items.map((p) => {
          const ai = p.verdict ? CONFLICT_VERDICT[p.verdict] || [p.verdict, ""] : null;
          const applyBtn =
            p.narrow &&
            can("admin") &&
            btn(`Áp dụng: gỡ "${p.narrow.phrase}" khỏi ${p.narrow.templateId}`, {
              small: true,
              kind: "primary",
              on: {
                click: (ev) =>
                  run(
                    ev.currentTarget,
                    async () => {
                      const res = await post("/api/kb/conflicts/apply", { templateId: p.narrow.templateId, phrase: p.narrow.phrase });
                      toast("Đã điền sẵn bản sửa ở bản nháp mới — xem lại rồi Publish.", "ok");
                      go(`/kb/edit/${res.versionId}`);
                    },
                    null,
                  ),
              },
            });
          return h(
            "div",
            { class: "row-card" },
            h("div", { class: "row-top" }, badge(/^Khách hỏi/.test(p.signals[0] || "") ? "bot trả lời nhầm" : p.verdict === "conflict" ? "nội dung mâu thuẫn" : p.verdict === "duplicate" ? "nội dung trùng" : "cần xem", "err")),
            h("div", { class: "form-row" }, h("div", { class: "field" }, refLine(ownSide(p), abLabel(p, ownSide(p)))), h("div", { class: "field" }, refLine(otherSide(p), abLabel(p, otherSide(p))))),
            h("div", { class: "small" }, h("ul", null, p.signals.slice(0, 2).map((x) => h("li", null, x)))),
            ai ? h("div", { class: "hint" }, badge(ai[0], ai[1]), " ", p.reason, p.suggestion ? h("div", null, "→ ", p.suggestion) : null) : h("div", { class: "hint" }, "Chưa có nhận xét của AI (chưa cấu hình LLM lúc publish, hoặc lời gọi lỗi)."),
            applyBtn ? h("div", { class: "actions" }, applyBtn) : null,
          );
        }),
      ),
    );
  }

  function kbDoc(slug) {
    return lazy(async (reload) => {
      const r = await get(`/api/kb/documents/${enc(slug)}`);
      const doc = r.document;
      const conflicts = doc.kind === "guide" ? [] : (await get("/api/kb/conflicts", { doc: slug })).items;
      const published = r.versions.find((v) => v.status === "published");
      const base = published || r.versions[0];
      const newQuery = `slug=${enc(doc.slug)}&kind=${enc(doc.kind)}&title=${enc(doc.title || doc.slug)}${base ? `&from=${base.id}` : ""}`;
      const isLive = r.versions.some((v) => v.status === "published");
      return h(
        "div",
        null,
        h("div", { class: "page-head" }, h("h2", null, doc.kind === "guide" ? "Hướng dẫn AI làm việc" : doc.slug), docKindBadge(doc.kind), link("← Tài liệu", "/kb", "small")),
        doc.kind === "guide" ? guideIntro() : null,
        can("admin")
          ? h(
              "div",
              { class: "actions" },
              link("Tạo phiên bản mới", `/kb/new?${newQuery}`, "btn btn-primary"),
              // "Hướng dẫn AI làm việc" là tài liệu bắt buộc duy nhất, không cho xoá (khớp kb/service.ts).
              doc.kind !== "guide"
                ? btn("Xoá tài liệu", {
                    small: true,
                    kind: "danger",
                    title: isLive ? "Tài liệu ĐANG được bot dùng — xoá sẽ có hiệu lực ngay" : "Tài liệu chưa publish, chưa được bot dùng",
                    on: {
                      click: (ev) => {
                        const msg = isLive
                          ? `XOÁ HẲN tài liệu "${doc.slug}" đang được bot dùng thật?\nBot sẽ NGỪNG dùng nội dung này NGAY LẬP TỨC, và toàn bộ dữ liệu vector đã tính cho tài liệu này cũng bị xoá theo. Không hoàn tác được.`
                          : `Xoá hẳn tài liệu "${doc.slug}"?\nTài liệu này chưa publish nên xoá không ảnh hưởng gì tới bot. Không hoàn tác được.`;
                        if (!confirm(msg)) return;
                        run(ev.currentTarget, async () => {
                          await del(`/api/kb/documents/${enc(doc.slug)}`);
                          toast(`Đã xoá tài liệu ${doc.slug}.`, "ok");
                          go("/kb");
                        });
                      },
                    },
                  })
                : null,
            )
          : null,
        conflictsCard(slug, conflicts, reload),
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

  /** Mẫu chèn sẵn vào ô soạn thảo khi tạo tài liệu mới: người dùng sửa theo, không phải nhớ định dạng. */
  const SAMPLE_TEMPLATE = `---
id: vi-du-rut-tien                   # mã duy nhất (chữ thường, số, gạch ngang); dùng ở Câu hỏi mẫu, Hội thoại, Ticket
group: Withdraw                      # nhóm chủ đề (Withdraw, KYC, Wallet, Account, HCS, Game...)
response_mode: EXACT_TEMPLATE        # gửi nguyên văn câu trả lời bên dưới
priority: 500                        # trùng nhiều template thì số cao hơn thắng
match:
  keywords:                          # cụm từ khớp chữ (bỏ dấu, không phân biệt hoa thường)
    - withdraw
    - rút tiền
  examples:                          # CÂU KHÁCH THẬT HAY NHẮN, diễn đạt khác từ khoá: dùng để tìm theo ý nghĩa và để AI hiểu template này dành cho tình huống nào
    - when can I take my tokens out of the app?
    - bao giờ rút được ITLG về ví?
  excludes: []                       # điều kiện loại trừ (tên predicate ở Cấu hình → Predicates), vd [completed_level_1]
follow_up:                           # khách phản hồi sau câu trả lời này thì làm gì (ESCALATE = chuyển nhân viên, hoặc mã template khác)
  negative: ESCALATE
  thanks: you-are-welcome
sets_context:                        # ghi vào vụ việc của khách
  issue: withdraw availability
  status: pending                    # pending = còn theo dõi · resolved = đã xong · none
ticket:                              # (tuỳ chọn) khi tình huống này chuyển nhân viên: danh mục, mã lỗi, người phụ trách
  category: Wallet
  error_code: W01
  pic: Quang
required_info: [Interlink ID, screenshot]   # (tuỳ chọn) thông tin cần xin khách khi chuyển nhân viên
---
<!-- answer:en -->
Câu trả lời tiếng Anh (bắt buộc). Gửi nguyên văn cho khách. Giữ nguyên URL, @handle, tên sản phẩm.
<!-- answer:vi -->
Bản tiếng Việt do bạn soạn (tuỳ chọn). Ngôn ngữ khác chưa có sẽ được AI dịch một lần và chờ duyệt ở mục Bản dịch.
<!-- next -->
---
id: vi-du-thu-hai
group: Withdraw
response_mode: EXACT_TEMPLATE
priority: 500
match:
  keywords: [cụm từ khác]
  examples: [một câu khách hay nhắn]
sets_context: { issue: vấn đề, status: pending }
---
<!-- answer:en -->
Một file có thể chứa nhiều template, ngăn nhau bằng dòng <!-- next -->. Xoá phần không dùng trước khi Kiểm tra.
`;
  const SAMPLE_KNOWLEDGE = `---
slug: ten-tai-lieu                   # chữ thường, số, gạch ngang
title: Tên tài liệu
response_mode: GROUNDED_GENERATION   # bot trả lời từ nội dung này (trích đoạn hoặc AI viết có trích dẫn)
lang: vi                             # ngôn ngữ của tài liệu (vi | en). Bot dịch sang ngôn ngữ của khách khi trả lời
source_url: https://whitepaper.interlinklabs.ai   # (tuỳ chọn) link gửi kèm câu trả lời
---
## Tiêu đề mục 1

Nội dung mục 1. Mỗi mục "##" hoặc "###" là một đoạn tìm kiếm riêng; viết đủ ý trong một mục, tránh mục quá ngắn.

## Tiêu đề mục 2

Nội dung mục 2.
`;

  // ---------------------------------------------------------------- Trợ lý "Nạp nội dung mới"
  const INTAKE_VERDICT = { duplicate: ["trùng", "err"], subset: ["bao hàm", "warn"], conflict: ["mâu thuẫn", "err"], distinct: ["khác nhau", "ok"] };
  const firstQuoted = (s) => (/"([^"]+)"/.exec(s || "") || [])[1] || null;
  const lineIndexOf = (text, needle) => {
    if (!needle) return -1;
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    return idx < 0 ? -1 : text.slice(0, idx).split("\n").length - 1;
  };
  const intakePairKey = (box) => `${box.a.kind}:${box.a.id}|${box.b.kind}:${box.b.id}`;
  /** Nhãn vấn đề bằng lời thường: bot trả lời nhầm (đã hỏi thử) / nội dung mâu thuẫn / trùng (AI đọc) — thay cho "điểm 0.73". */
  const intakeProblemLabel = (box) =>
    (box.explain || []).length
      ? ["bot sẽ trả lời nhầm", "err"]
      : box.updateHint
        ? ["trùng gần nguyên văn", "err"]
        : box.verdict === "conflict"
          ? ["nội dung mâu thuẫn", "err"]
          : box.verdict === "duplicate"
            ? ["nội dung trùng", "warn"]
            : ["cần xem", "warn"];

  /** Nội dung bên trong popup phóng to của một khung xung đột: mô tả AI + (gỡ máy móc, hoặc sửa tự do + Kiểm tra lại + Save). */
  function intakeBoxDetail(box, resolvedDrafts, onChanged) {
    const already = resolvedDrafts.get(intakePairKey(box));
    const v = box.verdict ? INTAKE_VERDICT[box.verdict] || [box.verdict, ""] : null;
    const head = h(
      "div",
      null,
      h("div", { class: "row-top" }, badge(intakeProblemLabel(box)[0], intakeProblemLabel(box)[1]), h("b", null, box.b.title), h("span", { class: "muted small" }, " (", box.b.kind === "template" ? `mã ${box.b.id}, ` : "", "tài liệu ", box.b.doc, ")"), v && !(box.explain || []).length ? badge(v[0], v[1]) : null),
      (box.explain || []).length ? h("div", null, h("b", null, "Đã hỏi thử bot: "), h("ul", null, box.explain.map((x) => h("li", null, x)))) : null,
      box.updateHint ? h("div", { class: "small" }, box.updateHint) : null,
    );
    // Gợi ý AI có thể gọi tắt hai bên bằng "A"/"B" (xem content/skills/review-overlap/SKILL.md) — luôn giải thích rõ
    // A/B là cái nào ngay phía trên, để không ai phải đoán "A" hay "B" đang nói tới nội dung nào.
    const legend = box.reason && /\bA\b|\bB\b/.test(box.reason + " " + (box.suggestion || "")) ? h("div", { class: "small muted" }, "AI gọi tắt: A = nội dung bạn vừa đưa vào · B = ", h("code", null, box.b.id || box.b.title), " (đang dùng)") : null;
    const aiNote = box.reason
      ? h("div", { class: "hint" }, legend, h("div", null, h("b", null, "Gợi ý AI: "), box.reason, box.suggestion ? h("div", null, "→ ", box.suggestion) : null))
      : h("p", { class: "muted" }, "Chưa có nhận xét của AI cho cặp này.");
    let body;
    if (already) {
      body = notice("ok", `Đã lưu bản nháp mới cho ${already.slug} (v${already.versionId}) — sẽ được publish cùng khi bấm "Publish tất cả".`);
    } else if (box.narrow) {
      const applyBtn = btn(`Áp dụng: gỡ "${box.narrow.phrase}" khỏi ${box.narrow.templateId}`, {
        kind: "primary",
        on: {
          click: (ev) =>
            run(ev.currentTarget, async () => {
              const r = await post("/api/kb/intake/conflicts/apply", { templateId: box.narrow.templateId, phrase: box.narrow.phrase });
              resolvedDrafts.set(intakePairKey(box), { versionId: r.versionId, slug: r.slug });
              toast("Đã tạo bản nháp mới, đã gỡ đúng cụm gây trùng.", "ok");
              onChanged();
            }),
        },
      });
      body = h("div", null, h("p", { class: "muted" }, "Hệ thống biết chính xác cụm gây trùng — gỡ được ngay, không cần sửa tay."), h("div", { class: "actions" }, applyBtn));
    } else {
      const original = box.b.text || "";
      const needle = firstQuoted(box.signals[0]);
      const ta = h("textarea", { class: "intake-box-text", wrap: "off", spellcheck: "false" });
      ta.value = original;
      const gutter = h("div", { class: "intake-gutter" });
      const drawGutter = () => {
        clear(gutter);
        const mark = lineIndexOf(ta.value, needle);
        gutter.append(...ta.value.split("\n").map((_line, i) => h("div", { style: "height:20px" }, i === mark ? h("span", { class: "dot" }) : null)));
      };
      drawGutter();
      const recheckBtn = btn("Kiểm tra lại", {
        on: {
          click: (ev) =>
            run(ev.currentTarget, async () => {
              const r = await post("/api/kb/intake/conflicts/recheck", { editedText: ta.value, otherText: box.a.text || "" });
              saveBtn.disabled = !!r.stillConflicting;
              toast(r.stillConflicting ? "Vẫn còn trùng — sửa thêm rồi kiểm tra lại." : "Sạch — có thể Save.", r.stillConflicting ? "info" : "ok");
            }),
        },
      });
      const saveBtn = btn("Save", {
        kind: "primary",
        disabled: true,
        on: {
          click: (ev) =>
            run(ev.currentTarget, async () => {
              const editBody =
                box.b.kind === "template" ? { targetDoc: box.b.doc, kind: "template", templateId: box.b.id, lang: "en", newText: ta.value } : { targetDoc: box.b.doc, kind: "chunk", chunkHeading: box.b.title, newText: ta.value };
              const r = await post("/api/kb/intake/conflicts/apply", editBody);
              resolvedDrafts.set(intakePairKey(box), { versionId: r.versionId, slug: r.slug });
              toast("Đã lưu bản nháp mới.", "ok");
              onChanged();
            }),
        },
      });
      ta.addEventListener("input", () => {
        drawGutter();
        saveBtn.disabled = true;
      });
      body = h(
        "div",
        null,
        h("p", { class: "muted" }, 'Sửa trực tiếp nội dung đang xung đột — giữ nguyên gợi ý AI, sửa một phần, hoặc viết lại tuỳ ý — rồi bấm "Kiểm tra lại"; Save chỉ bật khi đã sạch.'),
        h("div", { class: "intake-gutter-row" }, gutter, ta),
        h("div", { class: "actions" }, recheckBtn, saveBtn),
      );
    }
    return h("div", null, head, aiNote, h("hr"), body);
  }

  function openIntakeModal(box, resolvedDrafts, onChanged) {
    const body = h("div", { class: "intake-modal-body" });
    const redraw = () => {
      clear(body);
      body.append(intakeBoxDetail(box, resolvedDrafts, () => (redraw(), onChanged())));
    };
    redraw();
    const backdrop = h("div", { class: "intake-backdrop" });
    const close = () => backdrop.remove();
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });
    backdrop.append(h("div", { class: "intake-modal" }, h("div", { class: "intake-modal-head" }, h("b", null, "Xung đột với ", box.b.doc), btn("Đóng", { small: true, on: { click: close } })), body));
    document.body.append(backdrop);
  }

  function intakeBoxCard(box, resolvedDrafts, onChanged) {
    const already = resolvedDrafts.get(intakePairKey(box));
    return h(
      "div",
      { class: "intake-box", on: { click: () => openIntakeModal(box, resolvedDrafts, onChanged) } },
      h("div", { class: "row-top" }, badge(intakeProblemLabel(box)[0], intakeProblemLabel(box)[1]), already ? badge("đã sửa", "ok") : null),
      h("div", null, h("b", null, box.b.title), " ", h("span", { class: "small muted" }, "(", box.b.kind === "template" ? `mã ${box.b.id}` : `tài liệu ${box.b.doc}`, ")")),
      (box.explain || []).length ? h("div", { class: "small" }, box.explain[0]) : box.reason ? h("div", { class: "small" }, box.reason) : null,
    );
  }

  /** Kéo-thả (hoặc bấm để chọn) tệp .txt/.md/.pdf/.doc/.docx/.xlsx — trích chữ qua server rồi đưa vào `targetTa`, không tự gửi đi. */
  function intakeDropzone(targetTa) {
    const ACCEPT = ".txt,.md,.markdown,.pdf,.doc,.docx,.xlsx,text/plain,text/markdown,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    const picker = h("input", { type: "file", accept: ACCEPT, style: "display:none" });
    const label = h("div", { class: "intake-dropzone-label" }, h("b", null, "Kéo thả tệp vào đây"), h("div", { class: "small muted" }, "hoặc bấm để chọn — .txt, .md, .pdf, .doc, .docx, .xlsx"));
    const zone = h("div", { class: "intake-dropzone", tabindex: "0", role: "button" }, label, picker);
    const setBusy = (busy, msg) => {
      zone.classList.toggle("busy", busy);
      clear(label);
      label.append(busy ? h("div", { class: "small" }, msg || "Đang đọc tệp...") : h("b", null, "Kéo thả tệp vào đây"), busy ? null : h("div", { class: "small muted" }, "hoặc bấm để chọn — .txt, .md, .pdf, .doc, .docx, .xlsx"));
    };
    const handleFile = async (file) => {
      if (!file) return;
      if (file.size > 15_000_000) return toast(`Tệp "${file.name}" vượt quá 15 MB`);
      setBusy(true, `Đang đọc "${file.name}"...`);
      try {
        const r = await uploadFile("/api/kb/intake/extract", file);
        targetTa.value = targetTa.value.trim() ? `${targetTa.value.trim()}\n\n${r.text}` : r.text;
        targetTa.dispatchEvent(new Event("input"));
        toast(`Đã đưa nội dung của "${r.filename}" vào ô Nội dung — xem lại rồi bấm Phân tích.`, "ok");
      } catch (e) {
        reportError(e);
      } finally {
        setBusy(false);
      }
    };
    zone.addEventListener("click", () => picker.click());
    zone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        picker.click();
      }
    });
    picker.addEventListener("change", () => {
      handleFile(picker.files && picker.files[0]);
      picker.value = "";
    });
    ["dragenter", "dragover"].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add("dragover");
      }),
    );
    ["dragleave", "drop"].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
      }),
    );
    zone.addEventListener("drop", (e) => handleFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]));
    return zone;
  }

  function kbIntakeNew() {
    return lazy(async () => {
      if (!can("admin")) return notice("warn", "Chỉ admin/owner được dùng trợ lý này.");
      const raw = h("textarea", { class: "editor", spellcheck: "false", "aria-label": "Nội dung tự do" });
      const kindHint = select([["", "Để AI phân tích"], ["templates", "Câu trả lời cố định (template)"], ["knowledge", "Tài liệu tri thức"]], "");
      const submit = btn("Phân tích & tạo bản nháp", {
        kind: "primary",
        on: {
          click: (ev) => {
            if (raw.value.trim().length < 20) return toast("Nội dung quá ngắn (tối thiểu 20 ký tự)");
            run(ev.currentTarget, async () => {
              const body = { rawText: raw.value.trim() };
              if (kindHint.value) body.kindHint = kindHint.value;
              const r = await post("/api/kb/intake", body);
              toast(`Đã tạo bản nháp ${r.version.slug}${r.boxes.length ? ` — ${r.boxes.length} khung xung đột cần xem` : ""}`, r.boxes.length ? "info" : "ok");
              go(`/kb/intake/${r.version.id}`);
            });
          },
        },
      });
      return h(
        "div",
        null,
        h("div", { class: "page-head" }, h("h2", null, "Nạp nội dung mới"), link("← Tài liệu", "/kb", "small")),
        notice(
          "info",
          'Dán văn bản tự do — ghi chú, câu trả lời hỗ trợ đã có, bản dịch... Hệ thống tự đoán loại nội dung và tạo đúng cấu trúc, không cần bạn tự viết YAML. Không tạo được tài liệu "Hướng dẫn AI làm việc" qua đường này.',
        ),
        h(
          "div",
          { class: "card" },
          intakeDropzone(raw),
          field("Nội dung", raw, "Càng đầy đủ càng tốt: tình huống khách hỏi, câu trả lời, các trường hợp liên quan. Kéo-thả tệp ở trên sẽ điền (nối thêm) vào đây."),
          field("Gợi ý loại (tuỳ chọn)", kindHint, "Không chắc thì để AI phân tích."),
          h("div", { class: "actions" }, submit),
        ),
      );
    });
  }

  function kbIntakeReview(idStr) {
    return lazy(async () => {
      const v = (await get(`/api/kb/versions/${enc(idStr)}`)).version;
      const editable = can("admin") && (v.status === "draft" || v.status === "rejected");
      const pane = editorPane({ md: v.source_md || "", readonly: !editable });
      const reportBox = h("div", null, renderReport(v.report));
      const saved = { md: v.source_md || "" };
      const dirty = () => pane.ta.value !== saved.md;
      const showReport = (r) => {
        clear(reportBox);
        reportBox.append(renderReport(r));
      };

      const resolvedDrafts = new Map(); // key cặp -> {versionId, slug}
      let boxesState = [];
      const grid = h("div", { class: "intake-grid" });
      const boxesCard = h("div");
      const redrawGrid = () => {
        clear(grid);
        grid.append(...boxesState.map((b) => intakeBoxCard(b, resolvedDrafts, redrawGrid)));
        clear(boxesCard);
        if (boxesState.length) boxesCard.append(card(`Xung đột (${boxesState.length})`, h("p", { class: "muted" }, "Mỗi khung là một tài liệu đang có sẵn bị trùng. Bấm vào để mở rộng, xem gợi ý của AI và xử lý."), grid));
      };
      const loadBoxes = async () => {
        const r = await get(`/api/kb/intake/${v.id}/boxes`);
        boxesState = r.boxes;
        redrawGrid();
      };
      await loadBoxes();

      const save = btn("Lưu Draft", {
        on: {
          click: () =>
            run(save, async () => {
              const r = await put(`/api/kb/versions/${v.id}`, { md: pane.ta.value });
              saved.md = pane.ta.value;
              showReport(r.report);
              toast(r.report.ok ? "Đã lưu, kiểm tra đạt." : "Đã lưu nhưng kiểm tra chưa đạt.", r.report.ok ? "ok" : "info");
            }),
        },
      });
      const validate = btn("Kiểm tra lại toàn bộ", {
        title: "Chạy lại 6 bước kiểm tra + dựng lại các khung xung đột trên bản đã lưu",
        on: {
          click: () => {
            if (dirty()) return toast("Có thay đổi chưa lưu: bấm Lưu Draft trước.");
            run(validate, async () => {
              showReport((await post(`/api/kb/versions/${v.id}/validate`, {})).report);
              await loadBoxes();
            });
          },
        },
      });
      const publishAll = btn("Publish tất cả", {
        kind: "primary",
        on: {
          click: () => {
            const ids = [v.id, ...[...resolvedDrafts.values()].map((x) => x.versionId)];
            const unresolved = boxesState.filter((b) => !resolvedDrafts.has(intakePairKey(b)));
            let msg = `Publish ${v.slug}${resolvedDrafts.size ? ` cùng ${resolvedDrafts.size} tài liệu vừa sửa` : ""}? Toàn bộ vector liên quan sẽ được cập nhật lại ngay.`;
            if (unresolved.length) msg += `\n\nCÒN ${unresolved.length} khung xung đột CHƯA xử lý:\n` + unresolved.map((b) => `- ${b.b.doc}: ${b.b.title}`).join("\n");
            if (dirty()) return toast("Có thay đổi chưa lưu: bấm Lưu Draft trước khi Publish.");
            if (!confirm(msg)) return;
            run(publishAll, async () => {
              const r = await post(`/api/kb/intake/${v.id}/publish-all`, { versionIds: ids });
              const ok = r.results.filter((x) => x.status).length;
              toast(`${ok}/${r.results.length} bản đã publish.` + (ok < r.results.length ? " Xem lỗi ở từng tài liệu, có thể thử lại." : ""), ok === r.results.length ? "ok" : "info");
              if (ok) go(`/kb/doc/${v.slug}`);
            });
          },
        },
      });

      return h(
        "div",
        null,
        h("div", { class: "page-head" }, h("h2", null, `Nạp nội dung mới — ${v.slug}`), link("← Tài liệu", "/kb", "small")),
        notice("info", "Nội dung bạn vừa đưa vào đã được tạo đúng cấu trúc hệ thống cần. Xem báo cáo bên dưới; nếu có khung xung đột, mở từng khung để xem gợi ý và xử lý trước khi Publish."),
        h("div", { class: "card" }, editable ? pane.node : h("pre", { class: "pre-wrap" }, v.source_md)),
        editable ? h("div", { class: "actions" }, save, validate) : null,
        reportBox,
        boxesCard,
        h("div", { class: "actions" }, publishAll),
      );
    });
  }

  function kbEditorNew(query) {
    return lazy(async () => {
      if (!can("admin")) return notice("warn", "Chỉ admin/owner được tạo tài liệu.");
      const from = query.get("from");
      let md = "";
      if (from) md = ((await get(`/api/kb/versions/${enc(from)}`)).version || {}).source_md || "";
      if (!md && !query.get("slug")) md = (query.get("kind") || "templates") === "knowledge" ? SAMPLE_KNOWLEDGE : SAMPLE_TEMPLATE;
      const existing = !!query.get("slug");
      const slug = h("input", { type: "text", value: query.get("slug") || "", maxlength: 80, placeholder: "vd. faq-kyc", readonly: existing || null });
      const kind = select([["templates", "templates (câu trả lời có sẵn)"], ["knowledge", "knowledge (tài liệu tri thức)"], ...(query.get("kind") === "guide" ? [["guide", "guide (Hướng dẫn AI làm việc)"]] : [])], query.get("kind") || "templates", { disabled: existing });
      const title = h("input", { type: "text", value: query.get("title") || "", maxlength: 200, placeholder: "Tiêu đề (tuỳ chọn)" });
      const pane = editorPane({
        md,
        onLoadedFile: (f) => {
          if (!slug.value && !existing) slug.value = f.name.replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
        },
      });
      const focus = query.get("focus");
      if (focus) {
        setTimeout(() => {
          const ta = pane.ta;
          const at = (() => { const want = "id: " + focus; let pos = 0; for (const line of ta.value.split("\n")) { if (line.trim() === want) return pos; pos += line.length + 1; } return -1; })();
          if (at < 0) return;
          const end = ta.value.indexOf("<!-- next -->", at);
          ta.focus();
          ta.setSelectionRange(at, end < 0 ? ta.value.length : end);
          const lineNo = ta.value.slice(0, at).split("\n").length;
          ta.scrollTop = Math.max(0, (lineNo - 3) * 20);
        }, 0);
      }
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
        existing ? notice("info", query.get("focus") ? `Đang sửa template ${query.get("focus")} (đã bôi đen bên dưới) trong tài liệu ${query.get("slug")}. Sửa câu trả lời, từ khoá hoặc câu mẫu rồi bấm Tạo phiên bản Draft & kiểm tra; các template khác trong tài liệu giữ nguyên.` : "Để trống ô Tiêu đề thì tài liệu giữ nguyên tiêu đề hiện có.") : null,
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
        h("div", { class: "card" }, h("div", { class: "actions" }, actions), editable ? h("p", { class: "hint" }, "Publish có thể trả về \"chờ duyệt\": nếu tài liệu có luật bảo mật (SECURITY_RULE) thì chỉ owner được đề xuất và một người khác phải duyệt; Hướng dẫn AI làm việc thì luôn cần một người khác duyệt.") : null, pane.node),
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
    if (r.guide) wrap.append(notice("warn", "Hướng dẫn AI làm việc thay đổi cách AI phán đoán: Publish sẽ tạo đề xuất và cần một quản trị viên khác duyệt."));
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

  /** Mở trình soạn thảo phiên bản mới của tài liệu chứa template, đặt con trỏ tại template đó. */
  async function editTemplate(docSlug, templateId) {
    const d = await get(`/api/kb/documents/${enc(docSlug)}`);
    const published = d.versions.find((v) => v.status === "published") || d.versions[0];
    go(`/kb/new?slug=${enc(docSlug)}&kind=templates&title=${enc(d.document.title || docSlug)}${published ? `&from=${published.id}` : ""}&focus=${enc(templateId)}`);
  }

  // ---- Chồng lấn nội dung: code cờ cặp (chính bộ tìm kiếm lúc chạy thật) -> AI phán xét từng cặp -> admin quyết ----
  const VERDICT = { duplicate: ["trùng", "err"], subset: ["bao hàm", "warn"], conflict: ["mâu thuẫn", "err"], distinct: ["khác nhau", "ok"] };
  function overlapCard(docs) {
    const min = h("input", { type: "number", min: "0.2", max: "0.99", step: "0.05", value: "0.55" });
    const holder = h("div");
    const reviews = new Map();
    let pairs = [];
    const keyOf = (p) => `${p.a.kind}:${p.a.id}|${p.b.kind}:${p.b.id}`;
    const refCell = (r) => h("div", null, h("div", null, badge(r.kind === "template" ? "template" : "đoạn tri thức", r.kind === "template" ? "info" : "muted"), " ", h("code", null, r.kind === "template" ? r.id : r.doc)), h("div", { class: "small muted" }, r.title));
    const fix = (r) => (r.kind === "template" ? (can("admin") && docs[r.id] ? btn("Sửa " + r.id, { small: true, on: { click: () => editTemplate(docs[r.id], r.id) } }) : null) : link("Mở " + r.doc, `/kb/doc/${enc(r.doc)}`, "small"));
    const reviewPairs = async (list) => {
      const res = await post("/api/kb/overlap/review", { pairs: list.map((p) => ({ a: { kind: p.a.kind, id: p.a.id }, b: { kind: p.b.kind, id: p.b.id }, signals: p.signals.slice(0, 5) })) });
      for (const x of res.results) reviews.set(`${x.a.kind}:${x.a.id}|${x.b.kind}:${x.b.id}`, x);
      draw();
    };
    let showQuiet = false;
    let fixHint = "";
    const draw = () => {
      clear(holder);
      if (!scanned) {
        holder.append(h("p", { class: "muted" }, "Chưa kiểm tra."));
        return;
      }
      const real = pairs.filter((p) => p.confirmed);
      const quiet = pairs.filter((p) => !p.confirmed);
      holder.append(
        real.length
          ? notice("err", `Bot đang trả lời nhầm ở ${fmtNum(real.length)} chỗ — cần sửa. ${fixHint}`)
          : notice("ok", "Không có chỗ nào bot trả lời nhầm. Mọi câu ví dụ / từ khoá của từng mục đều được bot trả lời bằng đúng mục đó."),
      );
      if (quiet.length)
        holder.append(
          h(
            "div",
            { class: "actions" },
            h("span", { class: "hint" }, `${fmtNum(quiet.length)} cặp chỉ giống chữ (cùng chủ đề) — đã hỏi thử, bot vẫn trả lời đúng, không cần sửa. Muốn AI đọc xem nội dung có nói mâu thuẫn nhau không thì bấm "Xem" rồi bấm "AI" ở cặp cần xem.`),
            btn(showQuiet ? "Ẩn" : "Xem", { small: true, on: { click: () => ((showQuiet = !showQuiet), draw()) } }),
          ),
        );
      const list = showQuiet ? pairs : real;
      if (!list.length) return;
      holder.append(
        table(
          [
            { label: "Mục", cell: (p) => refCell(p.a) },
            { label: "Mục", cell: (p) => refCell(p.b) },
            { label: "Vấn đề", cell: (p) => h("div", { class: "small" }, (p.explain || []).length ? h("ul", null, p.explain.map((x) => h("li", null, x))) : p.updateHint ? h("div", null, p.updateHint) : h("span", { class: "muted" }, "chỉ giống chữ, bot vẫn trả lời đúng")) },
            {
              label: "AI nhận xét",
              cell: (p) => {
                const x = reviews.get(keyOf(p));
                if (!x) return h("span", { class: "muted" }, "chưa đánh giá");
                if (x.error) return badge("lỗi: " + short(x.error, 60), "err");
                const v = VERDICT[x.review.verdict] || [x.review.verdict, ""];
                return h("div", null, badge(v[0], v[1]), x.review.reason ? h("div", { class: "hint" }, x.review.reason) : null, x.review.suggestion ? h("div", { class: "small" }, "→ ", x.review.suggestion) : null);
              },
            },
            { label: "", cell: (p) => h("div", { class: "actions" }, btn("AI", { small: true, title: "Nhờ AI đọc xem hai mục có nói mâu thuẫn / trùng nhau không", on: { click: (ev) => run(ev.currentTarget, () => reviewPairs([p])) } }), fix(p.a), fix(p.b)) },
          ],
          list,
        ),
      );
    };
    let scanned = false;
    const scan = btn("Kiểm tra toàn bộ nội dung", {
      kind: "primary",
      on: {
        click: (ev) =>
          run(ev.currentTarget, async () => {
            const r = await get("/api/kb/overlap", { min: Number(min.value) || 0.55, max: 500 });
            pairs = r.pairs;
            fixHint = r.fixHint || "";
            scanned = true;
            showQuiet = false;
            reviews.clear();
            draw();
          }),
      },
    });
    draw();
    return card(
      "Kiểm tra bot có trả lời nhầm không",
      h("p", { class: "muted" }, "Hệ thống tự hỏi thử bot bằng từng câu ví dụ, từng từ khoá của mỗi mục (và tiêu đề các đoạn tài liệu), rồi báo những câu bị bot trả lời bằng MỤC KHÁC. Các mục chỉ giống chữ nhưng bot vẫn trả lời đúng thì không cần sửa. Không sửa gì tự động."),
      h("div", { class: "form-row" }, h("div", { class: "actions" }, scan)),
      h("details", null, h("summary", { class: "small muted" }, "Nâng cao"), h("div", { class: "field narrow" }, h("span", { class: "lbl" }, "Độ giống tối thiểu để đưa vào danh sách hỏi thử"), min, h("div", { class: "hint" }, "Mặc định 0.55. Chỉ ảnh hưởng số cặp \"giống chữ\" được liệt kê; chỗ bot trả lời nhầm luôn được tìm trên toàn bộ các mục."))),
      holder,
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
              { label: "Khớp bằng", cell: (t) => h("div", { class: "small" }, (t.keyword_list || []).length ? h("div", null, h("span", { class: "muted" }, "từ khoá: "), t.keyword_list.join(", "), t.keywords > t.keyword_list.length ? "…" : "") : null, (t.examples || []).length ? h("div", null, h("span", { class: "muted" }, "câu mẫu: "), t.examples.join(" · ")) : h("div", { class: "muted" }, "chưa có câu mẫu")) },
              {
                // Đọc ngay tại đây thay vì phải nhớ ID rồi mở tab "Câu hỏi mẫu" / chạy quét chồng lấn riêng.
                label: "Sức khoẻ",
                cell: (t) =>
                  h(
                    "div",
                    { class: "small" },
                    t.evalCount > 0 ? badge(`✔ ${t.evalCount} câu kiểm tra`, "ok") : badge("⚠ chưa có câu kiểm tra", "warn"),
                    (t.conflicts || []).length
                      ? h(
                          "div",
                          { title: t.conflicts.map((c) => `${c.withTitle} — độ giống ${c.score.toFixed(2)}`).join("\n") },
                          badge(`⚠ dễ nhầm với ${t.conflicts.length === 1 ? t.conflicts[0].withTitle : `${t.conflicts.length} mục khác`}`, "warn"),
                        )
                      : null,
                  ),
              },
              { label: "", cell: (t) => (can("admin") && r.docs[t.id] ? btn("Sửa", { small: true, on: { click: () => editTemplate(r.docs[t.id], t.id) } }) : null) },
            ],
            rows.slice(0, 300),
          ),
        );
      };
      search.addEventListener("input", draw);
      draw();
      return h("div", null, overlapCard(r.docs), h("div", { class: "form-row" }, h("div", { class: "field" }, search)), card(null, holder));
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
      notice("info", "Mọi nội dung AI đã dịch hoặc viết rồi gửi cho khách đều nằm ở đây để bạn xem lại: bản dịch template (theo mã), bản dịch đoạn tài liệu, và câu AI viết từ tài liệu. Tạo một lần, dùng lại cho các khách sau. Bạn có thể sửa nội dung rồi bấm Duyệt; bản đã duyệt là bản chính thức."),
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
              h("div", { class: "row-top" }, t.template_id.startsWith("chunk:") ? badge("đoạn tri thức (dịch)", "muted") : t.template_id.startsWith("answer:") ? badge("câu AI viết từ tài liệu", "warn") : h("code", null, t.template_id), badge(t.lang, "info"), statusBadge(t.status), badge(t.origin === "llm" ? "LLM" : "người sửa")),
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
    if (c.kind === "skill_update") return h("div", null, h("div", null, "SKILL: ", h("code", null, String(p.name))), h("details", null, h("summary", null, "xem nội dung đề xuất"), h("pre", { class: "pre-wrap small" }, String(p.markdown))));
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
    "router.mode": "hybrid (mặc định, theo sơ đồ workflow): tin khớp CHẮC CHẮN bằng luật, điều kiện hoặc từ khoá (cụm khớp chiếm phần lớn câu hỏi, câu bằng tiếng Anh/Việt) đi FAST PATH, 0 token; mọi tin còn lại đi nhánh AI/RAG. llm_first: mọi tin nhắn có chữ đều đi qua AI — AI xác định ngôn ngữ và nội dung, hệ thống tìm trong kho, AI chọn kết quả đúng, rồi dịch về ngôn ngữ của khách. Khoảng 2–3 lời gọi AI và vài giây cho mỗi tin. code_first: khớp bằng luật/từ khoá trước (0 token), chỉ gọi AI khi chưa rõ; cũng là chế độ tự động dùng khi AI không khả dụng.",
    "router.fast_verify": "Bật (mặc định): ở FAST PATH, câu trả lời khớp bằng từ khoá/luật phải được AI (model nhanh, ~1.000 token) xác nhận là giải quyết đúng câu hỏi trước khi gửi; không xác nhận được thì tin sang nhánh AI/RAG để tìm lại trong toàn bộ kho. Tắt: gửi ngay khi khớp (0 token, nhanh hơn, có thể trả sai ý với câu dài).",
    "router.tier3_mode": "Câu hỏi về dự án (tài liệu tri thức): generative (mặc định) = AI viết câu trả lời bằng ngôn ngữ của khách từ đoạn đã chọn, có trích dẫn; code kiểm số liệu, link, ngôn ngữ, không dự đoán giá; không đạt thì gửi nguyên văn đoạn. extractive = luôn gửi nguyên văn đoạn tài liệu (dịch trung thành nếu cần).",
    "router.tier3_min_score": "Điểm tối thiểu của đoạn tri thức để được dùng.",
    "router.tier3_verify": "Bật (khuyến nghị): LLM phải xác nhận đoạn tri thức trả lời đúng câu hỏi; khách vẫn nhận nguyên văn đoạn đã duyệt. Không xác nhận được thì chuyển người thật. Tắt: gửi đoạn có điểm cao nhất mà không kiểm tra.",
    "router.knowledge_lang": "Ngôn ngữ chính của tài liệu tri thức (tài liệu hiện có viết tiếng Anh: en). Câu hỏi của khách bằng ngôn ngữ khác được dịch sang ngôn ngữ này để tìm kiếm; câu trả lời luôn được dịch lại đúng ngôn ngữ khách đã hỏi.",
    "router.too_short_max_chars": "Tin ngắn hơn hoặc bằng số ký tự này bị coi là lời chào/quá ngắn.",
    "episode.t_gap_minutes": "Im lặng quá số phút này thì hội thoại chuyển sang tạm lắng.",
    "episode.t_abandon_days": "Tạm lắng quá số ngày này thì tự đóng.",
    "episode.summary_every_k": "Tóm tắt cuộn sau mỗi K tin chưa tóm tắt (cần LLM).",
    "episode.closed_lookback_days": "Số ngày nhìn lại hội thoại đã đóng để nối tiếp khi khách quay lại.",
    "episode.ask_when_unclear": "Khi câu hỏi mơ hồ giữa hai mục hỏi đáp đã được khai báo là khác nhau, bot hỏi lại khách 1 lần bằng câu hỏi lại đã duyệt; vẫn không rõ thì chuyển nhân viên. Tắt: chuyển nhân viên ngay. Chỉ có tác dụng khi SKILL select-answer có lựa chọn CLARIFY.",
    "antispam.stale_days": "Xoá bản ghi chống spam không hoạt động quá số ngày này.",
    "alerts.escalation_daily_threshold": "Cảnh báo owner khi số lần chuyển support trong ngày vượt ngưỡng.",
    "alerts.new_questions_threshold": "Cảnh báo khi số câu hỏi mới vượt ngưỡng (cần bổ sung template).",
    "alerts.whitepaper_stale_days": "Cảnh báo khi đồng bộ whitepaper quá số ngày.",
    "translation.send_unapproved": "Bật (mặc định): bot trả lời bằng ngôn ngữ của khách; bản dịch máy phải giữ nguyên URL, @handle, tên sản phẩm mới được gửi, và nằm ở mục Bản dịch để admin duyệt hoặc sửa. Tắt (chế độ chặt): chỉ gửi bản dịch đã duyệt, chưa duyệt thì gửi nguyên văn tiếng Anh. Lưu ý: câu trả lời tri thức được dịch tại chỗ và không có bước duyệt, nên ở chế độ chặt khách không dùng tiếng Việt hỏi tri thức (kho chủ yếu tiếng Việt) sẽ được chuyển cho người thật.",
    "approval.second_person": "Bật: thay đổi nhạy cảm (luật bảo mật, Hướng dẫn AI làm việc, SKILL, quản trị viên, cấu hình bảo vệ) phải được một quản trị viên KHÁC duyệt ở mục Chờ duyệt. Tắt: người đề xuất có đủ quyền thì áp dụng ngay (tiện hơn, nhưng một tài khoản bị lộ có thể đổi luật bảo mật một mình).",
    "limits.tokens_per_user_day": "Ngân sách token mỗi khách mỗi ngày; vượt thì không gọi LLM cho khách đó.",
    "batching.window_ms": "Cửa sổ gom các tin nhắn liên tiếp (ms).",
    "retention.media_days": "Số ngày lưu ảnh khách gửi.",
  };
  const SETTING_TITLE = {
    "router.semantic_confident": "Ngưỡng tin tưởng ngữ nghĩa",
    "router.semantic_margin": "Chênh lệch tối thiểu giữa hai ứng viên",
    "router.semantic_suggest": "Ngưỡng gợi ý ứng viên",
    "router.mode": "Luồng xử lý tin nhắn",
    "router.fast_verify": "AI kiểm duyệt câu trả lời ở FAST PATH",
    "router.tier3_mode": "Cách trả lời từ tri thức",
    "router.tier3_min_score": "Điểm tối thiểu của đoạn tri thức",
    "router.tier3_verify": "Xác nhận đoạn tri thức trước khi gửi",
    "router.knowledge_lang": "Ngôn ngữ chính của kho tri thức",
    "router.too_short_max_chars": "Độ dài tối đa của tin coi là quá ngắn",
    "episode.t_gap_minutes": "Thời gian im lặng trước khi tạm lắng (phút)",
    "episode.t_abandon_days": "Số ngày tạm lắng trước khi tự đóng",
    "episode.summary_every_k": "Tóm tắt sau mỗi bao nhiêu tin",
    "episode.closed_lookback_days": "Số ngày nhìn lại hội thoại đã đóng",
    "episode.ask_when_unclear": "Hỏi lại khách 1 lần khi mơ hồ giữa hai mục",
    "antispam.stale_days": "Số ngày giữ bản ghi chống spam",
    "alerts.escalation_daily_threshold": "Ngưỡng cảnh báo chuyển support mỗi ngày",
    "alerts.new_questions_threshold": "Ngưỡng cảnh báo câu hỏi mới",
    "alerts.whitepaper_stale_days": "Số ngày trễ đồng bộ whitepaper",
    "translation.send_unapproved": "Gửi bản dịch máy chưa duyệt",
    "approval.second_person": "Cần người thứ hai duyệt thay đổi nhạy cảm",
    "limits.tokens_per_user_day": "Ngân sách token mỗi khách mỗi ngày",
    "batching.window_ms": "Cửa sổ gom tin nhắn (ms)",
    "retention.media_days": "Số ngày lưu ảnh",
  };
  const SETTING_ENUM = { "router.mode": ["hybrid", "llm_first", "code_first"], "router.tier3_mode": ["extractive", "generative"], "router.knowledge_lang": ["vi", "en"] };

  /** Mô hình LLM: URL + khoá của gateway (chỉ owner) và hai model nhanh/mạnh (admin). Khoá không bao giờ được máy chủ trả về. */
  /** Kết quả "kiểm tra model" giữ lại giữa các lần vẽ lại trang (đổi model xong trang tải lại). */
  const probeStatus = new Map();

  /** Embedding: API ngoài (chính, cấu hình ở đây) + dịch vụ cục bộ trong .env (dự phòng khi API lỗi). Kho giữ vector của cả hai model. */
  async function embeddingSection(reload) {
    const v = await get("/api/embedding");
    const owner = can("owner");
    const url = h("input", { type: "url", value: v.baseUrl || "", placeholder: "https://platform.beeknoee.com/v1", disabled: owner ? null : true });
    const key = h("input", { type: "password", autocomplete: "new-password", placeholder: v.hasKey ? `đã lưu (${v.keyHint || "•••"}) — nhập để thay` : "chưa có khoá", disabled: owner && v.canStoreKey ? null : true });
    const model = h("input", { type: "text", value: v.model || "", placeholder: "gemini-embedding-001", maxlength: 200 });
    const dims = h("input", { type: "number", min: "1", max: "16000", value: v.dimensions || "", placeholder: "mặc định của model" });
    const saveConn = btn("Lưu kết nối", { kind: "primary", on: { click: () => run(saveConn, async () => { const body = { baseUrl: url.value.trim() }; if (key.value) body.apiKey = key.value; await put("/api/embedding/connection", body); reload(); }, "Đã lưu kết nối embedding.") } });
    const clear = btn("Bỏ dịch vụ ngoài", { small: true, disabled: !v.baseUrl, on: { click: () => { if (!confirm("Bỏ URL và khoá: bot chỉ dùng embedding cục bộ trong .env?")) return; run(clear, async () => { await put("/api/embedding/connection", { baseUrl: "", apiKey: "" }); reload(); }, "Đã bỏ dịch vụ ngoài"); } } });
    const saveModel = btn("Lưu model", { kind: "primary", on: { click: () => run(saveModel, async () => { await put("/api/embedding/model", { model: model.value.trim(), dimensions: dims.value ? Number(dims.value) : null }); reload(); }, "Đã lưu model. Nếu đang chọn API, worker sẽ đánh chỉ mục lại kho bằng model này.") } });
    const probe = btn("Thử", { small: true, title: "Gọi thử API với model đang nhập (một câu ngắn), chưa lưu", on: { click: () => run(probe, async () => { const r = await post("/api/embedding/probe", { model: model.value.trim() || undefined, dimensions: dims.value ? Number(dims.value) : null }); toast(r.ok ? `${r.model}: ${r.dimensions} chiều, ${r.latencyMs} ms` : `${r.model || "embedding"} lỗi: ${r.error}`, r.ok ? "ok" : "err"); }) } });
    const covered = (m) => (v.coverage.find((c) => c.model === m) || { n: 0 }).n;

    // ---- Chọn model đang dùng: đúng MỘT model cho cả kho lẫn câu hỏi, không dự phòng ngầm ----
    const choose = (provider, label, sub, disabledReason) => {
      const on = v.provider === provider;
      const b = btn(label, {
        kind: on ? "primary" : undefined,
        disabled: !!disabledReason || on,
        title: disabledReason || (on ? "Đang dùng" : `Chuyển sang ${label}: worker sẽ đánh chỉ mục lại toàn bộ nội dung đã publish bằng model này`),
        on: {
          click: () => {
            if (!confirm(`Chuyển model embedding sang "${label}"?\nToàn bộ nội dung đã publish sẽ được đánh chỉ mục lại bằng model này (chạy nền). Trong lúc đó, đoạn chưa có vector chỉ tìm được bằng từ khoá.`)) return;
            run(b, async () => { await put("/api/embedding/provider", { provider }); reload(); }, `Đã chuyển sang ${label}. Đang đánh chỉ mục lại...`);
          },
        },
      });
      return h("div", { class: "row-card" }, h("div", { class: "row-top" }, b, on ? badge("đang dùng", "ok") : null), h("div", { class: "hint" }, sub));
    };
    const extReason = v.locked ? "Đang bị KHOÁ sau sự cố — kiểm tra rồi bấm 'Thử API & mở khoá' trước" : !v.configured ? "Chưa cấu hình URL + model bên dưới" : "";
    const picker = h("div", { class: "grid grid-2 tight" },
      choose("local", `Cục bộ · ${v.local}`, "Chạy trong hệ thống (.env), không tốn phí, không phụ thuộc mạng ngoài.", ""),
      choose("external", v.external ? `API ngoài · ${v.external}` : "API ngoài", "Dịch vụ embedding qua mạng (cấu hình bên dưới). Lỗi kết nối sẽ tự chuyển về cục bộ và khoá lựa chọn này.", extReason),
    );

    // ---- Khoá sau sự cố: cảnh báo đỏ + nút kiểm tra & mở khoá ----
    const unlock = btn("Thử API & mở khoá", {
      kind: "primary",
      on: {
        click: () =>
          run(unlock, async () => {
            const r = await post("/api/embedding/unlock", {});
            toast(r.ok ? `API phản hồi (${r.model}, ${r.dimensions} chiều, ${r.latencyMs} ms). Đã mở khoá — chọn lại "API ngoài" nếu muốn dùng.` : `API vẫn lỗi: ${r.error}. Chưa mở khoá.`, r.ok ? "ok" : "err");
            reload();
          }),
      },
    });
    const lockNotice = v.locked
      ? notice("err", `Hệ thống đã TỰ CHUYỂN sang embedding cục bộ (${v.local}) lúc ${fmtDate(v.lockedAt)} vì API ngoài lỗi: "${v.lockReason || "?"}". Toàn bộ nội dung đã publish đã/đang được đánh chỉ mục lại bằng ${v.local}. Lựa chọn "API ngoài" đang bị KHOÁ. Kiểm tra lại URL, khoá API, hạn mức dịch vụ rồi bấm nút bên dưới; mở khoá xong hãy chọn lại "API ngoài" nếu muốn.`)
      : null;

    // ---- Tình trạng chỉ mục của model đang dùng ----
    const done = covered(v.active);
    const reindex = btn("Đánh chỉ mục lại", { small: true, disabled: v.reindexPending, title: "Tính lại vector còn thiếu của mọi đoạn đã publish bằng model đang dùng (chạy nền)", on: { click: () => run(reindex, async () => { await post("/api/embedding/reindex", {}); reload(); }, "Đã xếp việc đánh chỉ mục lại") } });
    const indexStatus = h("div", { class: "row-card" },
      h("div", { class: "row-top" }, h("strong", null, `Đang dùng: ${v.active}`), v.reindexPending ? badge("đang đánh chỉ mục lại...", "warn") : done >= v.chunks ? badge(`đủ vector ${done}/${v.chunks} đoạn`, "ok") : badge(`vector ${done}/${v.chunks} đoạn`, "warn"), reindex),
      h("div", { class: "hint" }, done >= v.chunks && !v.reindexPending ? "Mọi đoạn tri thức đã publish đều có vector của model này. Vector câu mẫu template tính khi nạp nội dung." : "Đoạn chưa có vector chỉ tìm được bằng từ khoá cho tới khi worker đánh chỉ mục xong (tự chạy mỗi 10 phút, hoặc bấm nút)."),
    );

    return card(
      "Embedding (tìm theo ngữ nghĩa)",
      lockNotice,
      h("h3", null, "Model đang dùng"),
      h("p", { class: "muted" }, "Chọn đúng một model. Kho tri thức và câu hỏi của khách luôn dùng cùng model này; vector của hai model không so sánh được nên không có chuyện trộn lẫn."),
      picker,
      v.locked ? h("div", { class: "actions" }, unlock) : null,
      indexStatus,
      h("h3", null, "Dịch vụ embedding ngoài"),
      h("div", { class: "grid grid-2 tight" },
        h("label", { class: "field" }, h("span", { class: "lbl" }, "URL dịch vụ embedding"), url, h("div", { class: "hint" }, "Endpoint tương thích OpenAI, kết thúc bằng /v1 (vd platform.beeknoee.com/v1). " + (owner ? "" : "Chỉ owner được đổi."))),
        h("label", { class: "field" }, h("span", { class: "lbl" }, "Khoá API"), key, h("div", { class: "hint" }, v.canStoreKey ? "Được mã hoá khi lưu và không hiển thị lại." : "Máy chủ chưa đặt SECRETS_KEY nên chưa lưu được khoá từ web."))),
      owner ? h("div", { class: "actions conn-actions" }, saveConn, clear) : null,
      h("div", { class: "grid grid-2 tight" },
        h("label", { class: "field" }, h("span", { class: "lbl" }, "Model"), model, h("div", { class: "hint" }, "Tên model của dịch vụ, vd gemini-embedding-001, text-embedding-3-small.")),
        h("label", { class: "field" }, h("span", { class: "lbl" }, "Số chiều (tuỳ chọn)"), dims, h("div", { class: "hint" }, "Để trống = mặc định của model. Đổi số chiều = đổi không gian vector, kho phải đánh chỉ mục lại."))),
      h("div", { class: "actions" }, saveModel, probe),
      h("div", { class: "hint" }, `Vector hiện có trong kho (${v.chunks} đoạn): ` + v.models.map((m) => `${m}: ${covered(m)}/${v.chunks}`).join(" · ") + ". Vector của model không được chọn để nguyên, không dùng."),
    );
  }

  async function llmSection(reload) {
    const v = await get("/api/llm");
    const owner = can("owner");
    const src = (x) => (x === "custom" ? badge("tuỳ chỉnh", "info") : x === "env" ? badge("từ .env") : badge("chưa có", "warn"));

    const panel = h("div", { class: "model-panel" }, h("div", { class: "hint" }, "Đang lấy danh sách model từ gateway..."));

    /** Bảng model gateway cung cấp: kiểm tra dùng được hay không và chọn làm model nhanh/mạnh bằng một cú bấm. */
    const drawPanel = (models) => {
      const body = h("div");
      const draw = () => {
        clear(body);
        body.append(
          table(
            [
              { label: "Model", cell: (m) => h("code", null, m) },
              {
                label: "Kiểm tra",
                cell: (m) => {
                  const st = probeStatus.get(m);
                  if (!st) return h("span", { class: "muted" }, "chưa kiểm tra");
                  if (st.ok) return badge("dùng được, " + st.latencyMs + " ms", "ok");
                  return h("span", { title: st.error || "" }, badge("không dùng được", "err"), " ", h("span", { class: "muted small" }, short(String(st.error || ""), 90)));
                },
              },
              { label: "Đang dùng", cell: (m) => h("span", { class: "chips" }, m === v.modelFast ? badge("nhanh", "info") : null, m === v.modelStrong ? badge("mạnh", "info") : null) },
              {
                label: "",
                cell: (m) => {
                  const bad = probeStatus.get(m) && !probeStatus.get(m).ok;
                  const use = (tier, name) => {
                    const b = btn(name, { small: true, disabled: bad, title: bad ? "Model này không dùng được với tài khoản của bạn" : "", on: { click: () => run(b, async () => { await put("/api/llm/models", { [tier]: m }); reload(); }, `Đã chọn ${m} làm model ${tier === "fast" ? "nhanh" : "mạnh"}`) } });
                    return b;
                  };
                  return h("div", { class: "actions" }, use("fast", "Dùng làm nhanh"), use("strong", "Dùng làm mạnh"));
                },
              },
            ],
            models,
            { empty: "Gateway không liệt kê model nào" },
          ),
        );
      };
      const probeBtn = btn("Kiểm tra tất cả model", {
        kind: "primary",
        title: "Gọi thử từng model (vài chục token mỗi model)",
        on: {
          click: () =>
            run(probeBtn, async () => {
              probeBtn.textContent = "Đang kiểm tra, có thể mất tới 30 giây...";
              try {
                const r = await post("/api/llm/probe", {});
                for (const x of r.results) probeStatus.set(x.model, x);
                draw();
                const okCount = r.results.filter((x) => x.ok).length;
                toast(`${okCount}/${r.results.length} model dùng được với tài khoản này`, okCount ? "ok" : "err");
              } finally {
                probeBtn.textContent = "Kiểm tra tất cả model";
              }
            }),
        },
      });
      draw();
      clear(panel);
      panel.append(
        h("h3", null, `Model gateway đang cung cấp (${models.length})`),
        h("p", { class: "muted" }, "Gateway liệt kê cả model tài khoản của bạn không dùng được. Bấm kiểm tra để biết model nào chạy được, rồi chọn cho model nhanh và model mạnh."),
        h("div", { class: "actions" }, probeBtn, btn("Tải lại danh sách", { on: { click: reload } })),
        body,
      );
    };
    const modelsFetch = get("/api/llm/models");
    modelsFetch
      .then((r) => drawPanel(r.models))
      .catch((e) => {
        clear(panel);
        panel.append(notice("warn", "Chưa lấy được danh sách model: " + e.message + ". Kiểm tra URL và khoá API ở trên; vẫn có thể gõ tên model vào các ô bên dưới."));
      });
    const modelsPromise = modelsFetch.then((r) => r.models).catch(() => []); // dùng cho ô gợi ý bên dưới, không ném lỗi lần hai

    const url = h("input", { type: "text", inputmode: "url", value: v.baseUrl, placeholder: "http://localhost:20128/v1", disabled: !owner, autocomplete: "off" });
    const key = h("input", { type: "password", placeholder: v.hasKey ? `đã lưu ${v.keyHint || ""} — để trống để giữ nguyên` : "chưa có khoá", disabled: !owner || !v.canStoreKey, autocomplete: "new-password" });
    const saveConn = btn("Lưu kết nối", {
      kind: "primary",
      on: {
        click: () => {
          const body = { baseUrl: url.value.trim() };
          if (key.value.trim()) body.apiKey = key.value.trim();
          run(saveConn, async () => {
            await put("/api/llm/connection", body);
            reload();
          }, "Đã lưu kết nối gateway");
        },
      },
    });
    const clearKey = btn("Xoá khoá đã lưu", {
      small: true,
      disabled: v.keySource !== "custom",
      on: { click: () => confirm("Xoá khoá đã lưu trong hệ thống? Bot sẽ dùng LLM_API_KEY trong .env (nếu có).") && run(clearKey, async () => { await put("/api/llm/connection", { apiKey: "" }); reload(); }, "Đã xoá khoá") },
    });
    const resetUrl = btn("Dùng URL trong .env", {
      small: true,
      disabled: v.baseUrlSource !== "custom",
      on: { click: () => run(resetUrl, async () => { await put("/api/llm/connection", { baseUrl: "" }); reload(); }, "Đã quay về URL trong .env") },
    });

    const modelRow = (tier, title, label, desc, cur, source, envVal) => {
      const input = combobox({ value: cur, placeholder: "vd cx/gpt-5.4-mini", options: () => modelsPromise });
      const save = btn("Lưu", {
        small: true,
        kind: "primary",
        on: { click: () => run(save, async () => { await put("/api/llm/models", { [tier]: input.value.trim() }); reload(); }, `Đã lưu ${title.toLowerCase()}`) },
      });
      const test = btn("Thử", {
        small: true,
        title: "Gọi thử model đang nhập qua gateway (vài chục token), chưa lưu",
        on: {
          click: () =>
            run(test, async () => {
              const r = await post("/api/llm/test", { tier, ...(input.value.trim() ? { model: input.value.trim() } : {}) }); // thử đúng giá trị đang nhập, chưa lưu
              toast(r.ok ? `${title}: ${r.model} phản hồi trong ${r.latencyMs} ms` : `${title}: ${r.model} lỗi. ${r.error}`, r.ok ? "ok" : "err");
            }),
        },
      });
      const reset = btn("Về mặc định", { small: true, disabled: source !== "custom", on: { click: () => run(reset, async () => { await put("/api/llm/models", { [tier]: "" }); reload(); }, tier === "intake" ? "Đã bỏ chọn riêng — dùng lại chung model nhanh" : "Đã quay về giá trị trong .env") } });
      return h("div", { class: "form-row setting" }, h("label", { class: "field" }, h("span", { class: "lbl" }, title, " ", src(source)), input, h("div", { class: "hint" }, desc, envVal ? ` Mặc định trong .env: ${envVal}. ` : " ", h("code", null, label))), h("div", { class: "actions" }, save, test, reset));
    };

    return card(
      "Mô hình LLM",
      v.recent && v.recent.calls > 0 && v.recent.failed > 0 && v.recent.failed >= v.recent.calls / 2
        ? notice("err", `${v.recent.failed}/${v.recent.calls} lời gọi AI trong 1 giờ qua bị LỖI (${v.recent.lastError || "?"}). Khi AI không gọi được, bot âm thầm chuyển sang khớp từ khoá và chuyển nhân viên nhiều hơn. ${v.inDocker && /localhost|127\.0\.0\.1/.test(v.baseUrl || "") ? "URL gateway đang là localhost trong khi hệ thống chạy trong Docker: hãy đổi sang host.docker.internal hoặc bấm Về mặc định (.env)." : "Kiểm tra URL gateway, khoá API và bấm Thử."}`)
        : v.recent && v.recent.calls > 0 ? notice("ok", `${v.recent.calls - v.recent.failed}/${v.recent.calls} lời gọi AI trong 1 giờ qua thành công.`) : null,
      v.ready ? notice("ok", "LLM đã sẵn sàng. Thay đổi có hiệu lực cho bot trong vài giây, không cần khởi động lại.") : notice("warn", "Chưa cấu hình đủ (URL gateway và hai model): bot chỉ chạy tầng 0-1 và chuyển câu lạ cho người thật."),
      h("div", { class: "grid grid-2 tight" }, h("label", { class: "field" }, h("span", { class: "lbl" }, "URL gateway (9router) ", src(v.baseUrlSource)), url, h("div", { class: "hint" }, "Endpoint tương thích OpenAI, thường kết thúc bằng /v1. " + (owner ? "" : "Chỉ owner được đổi."))), h("label", { class: "field" }, h("span", { class: "lbl" }, "Khoá API ", src(v.keySource)), key, h("div", { class: "hint" }, v.canStoreKey ? "Được mã hoá khi lưu và không hiển thị lại." : "Máy chủ chưa đặt SECRETS_KEY nên chưa lưu được khoá từ web; dùng LLM_API_KEY trong .env."))),
      owner ? h("div", { class: "actions conn-actions" }, saveConn, resetUrl, clearKey) : null,
      modelRow("fast", "Model nhanh", "LLM_MODEL_FAST", "Phân loại câu hỏi (tầng 2), đọc ảnh, tóm tắt. Chọn model nhanh, rẻ.", v.modelFast, v.modelFastSource, v.env.modelFast),
      modelRow("strong", "Model mạnh", "LLM_MODEL_STRONG", "Dịch template và trả lời từ tri thức (tầng 3). Chọn model mạnh hơn.", v.modelStrong, v.modelStrongSource, v.env.modelStrong),
      modelRow(
        "intake",
        "Model nạp nội dung",
        "cấu hình riêng, không có .env",
        `Trợ lý "Nạp nội dung mới" (phân loại + tạo cấu trúc + mô tả xung đột). ${v.modelIntakeSource === "fallback" ? `Chưa chọn riêng — đang dùng chung model nhanh (${v.modelFast}), tức chung quota với bot.` : "Đã chọn riêng, tách quota khỏi model phục vụ khách."}`,
        v.modelIntakeSource === "fallback" ? "" : v.modelIntake,
        v.modelIntakeSource,
        null,
      ),
      panel,
    );
  }

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
      const GROUP_LABEL = { router: "Định tuyến", episode: "Hội thoại", antispam: "Chống spam", alerts: "Cảnh báo", limits: "Giới hạn", translation: "Bản dịch", approval: "Duyệt", batching: "Gom tin nhắn", retention: "Lưu trữ" };

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
          { class: "form-row setting" },
          h("label", { class: "field" }, h("span", { class: "lbl" }, SETTING_TITLE[it.key] || it.key, " ", it.custom ? badge("tuỳ chỉnh", "info") : badge("mặc định")), control, h("div", { class: "hint" }, SETTING_DESC[it.key] || "", ` Mặc định: ${String(it.default)}. `, h("code", null, it.key))),
          edit ? h("div", { class: "actions" }, saveBtn, resetBtn) : null,
        );
      };

      const nodes = [pageHead("Cấu hình"), edit ? null : notice("info", "Quyền viewer: chỉ xem cấu hình.")];
      if (edit) nodes.push(await llmSection(reload), await embeddingSection(reload));
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
        pageHead("Chi phí LLM"),
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
      const aiBtn = btn("Đánh giá các câu sai bằng AI", {
        title: "Chạy đúng luồng bot thật (có AI) cho các câu đang sai ở tầng 0-1, và nhờ AI nhận xét kỳ vọng có hợp lý không. Tốn token.",
        on: {
          click: () =>
            run(aiBtn, async () => {
              const r = await post("/api/eval/review", { scope: "failures", limit: 30 });
              clear(result);
              const V = { ok: ["kỳ vọng hợp lý", "ok"], better: ["nên đổi kỳ vọng", "warn"], escalate: ["nên là ESCALATE", "warn"], unsure: ["AI không chắc", "muted"] };
              result.append(
                card(
                  "Đánh giá bằng AI (các câu sai ở tầng 0-1)",
                  h("p", { class: "hint" }, "Cột 'Bot thật chọn' là kết quả khi câu này đi qua đúng luồng bot đang chạy (AI hiểu → tìm → AI chọn/kiểm duyệt). Cột 'AI nhận xét' chỉ là gợi ý: bạn quyết định sửa kỳ vọng hay sửa template."),
                  r.items.length
                    ? table(
                        [
                          { label: "Câu hỏi", cell: (x) => x.question },
                          { label: "Kỳ vọng", cell: (x) => chip(x.expected) },
                          { label: "Tầng 0-1", cell: (x) => chip(x.rulesOnly, x.rulesOnly === x.expected ? "" : "chip-err") },
                          { label: "Bot thật chọn", cell: (x) => chip(x.withAi, x.withAi === x.expected ? "chip-ok" : "chip-err") },
                          { label: "AI nhận xét", cell: (x) => (x.review ? h("div", null, badge((V[x.review.verdict] || [x.review.verdict, ""])[0], (V[x.review.verdict] || ["", ""])[1]), x.review.suggested ? [" → ", chip(x.review.suggested)] : null, x.review.reason ? h("div", { class: "hint" }, x.review.reason) : null) : "-") },
                          { label: "Dấu vết", cell: (x) => h("div", { class: "hint" }, (x.notes || []).join(" · ")) },
                        ],
                        r.items,
                      )
                    : h("p", { class: "muted" }, "Không có câu sai nào ở tầng 0-1."),
                ),
              );
            }),
        },
      });
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
        const exp = combobox({ placeholder: "Template id kỳ vọng (để trống = ESCALATE)", options: (tpl ? tpl.items : []).map((t) => t.id) });
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
        form = card("Thêm câu mẫu", h("div", { class: "form-row" }, field("Câu hỏi", q), field("Kỳ vọng", exp), field("Ảnh", img), h("div", { class: "actions" }, add)));
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

      return h("div", null, pageHead("Bộ câu hỏi mẫu"), notice("info", "Bộ câu mẫu dùng để kiểm tra hồi quy trước khi Publish. Chạy chỉ dùng tầng 0-1 (không tốn token)."), h("div", { class: "actions" }, runBtn, aiBtn), result, form, h("div", { class: "form-row" }, h("div", { class: "field" }, search)), card(null, holder));
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
