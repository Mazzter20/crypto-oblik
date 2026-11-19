/* Крипто-облік — логіка застосунку (без збірки, чистий JS + supabase-js) */
(() => {
  "use strict";

  // ---------- Налаштування ----------
  const cfg = window.APP_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });

  const KINDS = {
    uah_out:  { title: "Я дав гривні",     asset: "uah",  sign: +1 },
    usdt_in:  { title: "Мені кинули USDT", asset: "usdt", sign: -1 },
    usdt_out: { title: "Я кинув USDT",     asset: "usdt", sign: +1 },
    uah_in:   { title: "Мені дали гривні", asset: "uah",  sign: -1 },
  };
  const METHODS = {
    uah:  ["Карта", "Готівка", "IBAN", "Інше"],
    usdt: ["TRC20", "BEP20", "ERC20", "TON", "Binance Pay", "Bybit Pay", "Інше"],
  };

  const S = {
    user: null, profile: null, books: [], bookId: null, role: null,
    members: [], profiles: {}, contacts: [], ops: [],
    contactId: "", period: "all", from: "", to: "",
    editingOp: null, editingContact: null, edited: [], autoField: null,
    channel: null, reloadTimer: null, booted: false,
  };

  // ---------- Утиліти ----------
  const $ = (id) => document.getElementById(id);
  const fUah = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 });
  const fUsdt = new Intl.NumberFormat("uk-UA", { maximumFractionDigits: 2 });
  const fRate = new Intl.NumberFormat("uk-UA", { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const uahS = (n) => fUah.format(n) + " ₴";
  const usdtS = (n) => fUsdt.format(n) + " ₮";
  const signed = (n, f) => (n > 0.004 ? "+" : n < -0.004 ? "−" : "") + f(Math.abs(n));
  const parseNum = (v) => {
    const s = String(v ?? "").replace(/[\s ]/g, "").replace(",", ".");
    if (!s) return NaN;
    const n = Number(s);
    return isFinite(n) ? n : NaN;
  };
  const plain = (n, d) => String(Number(n.toFixed(d)));
  const today = () => new Date().toLocaleDateString("sv");
  const baseUrl = () => location.origin + location.pathname;
  const initial = (name) => (String(name || "?").trim()[0] || "?").toUpperCase();
  const colorFor = (id) => {
    let h = 0; for (const c of String(id || "")) h = (h * 31 + c.charCodeAt(0)) % 360;
    return `hsl(${h} 55% 45%)`;
  };

  function el(tag, attrs = {}, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") e.className = v;
      else if (k === "text") e.textContent = v;
      else if (k === "style") e.setAttribute("style", v);
      else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null && k !== false) e.append(k);
    return e;
  }
  function avatar(id, name, cls = "avatar") {
    return el("span", { class: cls, style: `background:${colorFor(id)}`, text: initial(name) });
  }

  let toastTimer;
  function toast(text) {
    const t = $("toast"); t.textContent = text; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
  }
  function setMsg(id, text, kind) {
    const m = $(id); m.textContent = text || ""; m.className = "msg" + (kind ? " " + kind : "");
  }
  function errText(e) {
    const m = String(e?.message || e || "");
    if (/Invalid login credentials/i.test(m)) return "Невірний email або пароль.";
    if (/Email not confirmed/i.test(m)) return "Email ще не підтверджено. Відкрий лист від нас і перейди за посиланням.";
    if (/User already registered/i.test(m)) return "Цей email вже зареєстровано. Спробуй увійти.";
    if (/Password should be at least/i.test(m)) return "Пароль має бути щонайменше 6 символів.";
    if (/rate limit|too many/i.test(m)) return "Забагато спроб. Зачекай хвилину і спробуй ще раз.";
    if (/invalid_code/.test(m)) return "Такого коду запрошення немає.";
    if (/not_owner/.test(m)) return "Це може зробити лише власник книги.";
    if (/Failed to fetch|NetworkError/i.test(m)) return "Немає з'єднання з сервером. Перевір інтернет.";
    return m || "Щось пішло не так.";
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast("Скопійовано"); }
    catch { window.prompt("Скопіюй вручну:", text); }
  }

  // ---------- Тема ----------
  function applyTheme(t) {
    if (t) document.documentElement.setAttribute("data-theme", t);
    else document.documentElement.removeAttribute("data-theme");
  }
  try { applyTheme(localStorage.getItem("theme")); } catch {}
  $("themeBtn").addEventListener("click", () => {
    const cur = document.documentElement.getAttribute("data-theme") ||
      (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = cur === "dark" ? "light" : "dark";
    applyTheme(next); try { localStorage.setItem("theme", next); } catch {}
  });

  // ---------- Запрошення з посилання ----------
  const urlJoin = new URLSearchParams(location.search).get("join");
  if (urlJoin) {
    try { sessionStorage.setItem("pendingJoin", urlJoin); } catch {}
    history.replaceState(null, "", baseUrl() + location.hash);
  }
  const pendingJoin = () => { try { return sessionStorage.getItem("pendingJoin"); } catch { return null; } };

  // ---------- Екрани ----------
  function show(view) {
    $("authView").hidden = view !== "auth";
    $("resetView").hidden = view !== "reset";
    $("appView").hidden = view !== "app";
  }

  // ---------- Авторизація ----------
  let authMode = "login";
  function setAuthMode(m) {
    authMode = m;
    $("tabLogin").setAttribute("aria-selected", String(m === "login"));
    $("tabSignup").setAttribute("aria-selected", String(m === "signup"));
    $("nameField").hidden = m !== "signup";
    $("authSubmit").textContent = m === "login" ? "Увійти" : "Створити акаунт";
    $("authPass").setAttribute("autocomplete", m === "login" ? "current-password" : "new-password");
    $("forgotBtn").hidden = m !== "login";
    setMsg("authMsg", "");
  }
  $("tabLogin").addEventListener("click", () => setAuthMode("login"));
  $("tabSignup").addEventListener("click", () => setAuthMode("signup"));

  $("authForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("authEmail").value.trim(), password = $("authPass").value;
    const btn = $("authSubmit"); btn.disabled = true; setMsg("authMsg", "Зачекай…");
    try {
      if (authMode === "login") {
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
        setMsg("authMsg", "");
      } else {
        const display_name = $("authName").value.trim();
        const { data, error } = await sb.auth.signUp({
          email, password, options: { data: { display_name }, emailRedirectTo: baseUrl() },
        });
        if (error) throw error;
        if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
          setMsg("authMsg", "Цей email вже зареєстровано. Спробуй увійти.", "err");
        } else if (!data.session) {
          setAuthMode("login"); setMsg("authMsg", "Ми надіслали лист на " + email + ". Підтвердь email і увійди.", "ok");
        }
      }
    } catch (err) { setMsg("authMsg", errText(err), "err"); }
    finally { btn.disabled = false; }
  });

  $("forgotBtn").addEventListener("click", async () => {
    const email = $("authEmail").value.trim();
    if (!email) { setMsg("authMsg", "Впиши email, і ми надішлемо посилання для нового пароля.", "err"); return; }
    const { error } = await sb.auth.resetPasswordForEmail(email, { redirectTo: baseUrl() });
    setMsg("authMsg", error ? errText(error) : "Лист для зміни пароля надіслано на " + email + ".", error ? "err" : "ok");
  });

  $("resetForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.updateUser({ password: $("newPass").value });
    if (error) { setMsg("resetMsg", errText(error), "err"); return; }
    toast("Пароль змінено");
    const { data } = await sb.auth.getSession();
    if (data.session) boot(data.session); else show("auth");
  });

  let recovering = false;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === "PASSWORD_RECOVERY") { recovering = true; show("reset"); return; }
    if (recovering) return;
    if (event === "SIGNED_OUT" || !session) { teardown(); show("auth"); return; }
    if ((event === "SIGNED_IN" || event === "INITIAL_SESSION") && (!S.booted || S.user?.id !== session.user.id)) {
      setTimeout(() => boot(session), 0);
    }
  });

  function teardown() {
    if (S.channel) { sb.removeChannel(S.channel); S.channel = null; }
    Object.assign(S, { user: null, profile: null, books: [], bookId: null, contacts: [], ops: [], members: [], profiles: {}, booted: false, contactId: "" });
    const pj = pendingJoin();
    $("inviteNote").hidden = !pj;
    if (pj) $("inviteNote").textContent = "Тебе запросили в спільну книгу обліку. Увійди або зареєструйся, щоб приєднатися.";
  }

  // ---------- Завантаження ----------
  async function boot(session) {
    S.booted = true;
    S.user = session.user;
    show("app");
    $("opDate").value = today();
    const { data: prof } = await sb.from("profiles").select("id, display_name").eq("id", S.user.id).maybeSingle();
    S.profile = prof || { id: S.user.id, display_name: S.user.email.split("@")[0] };
    renderUser();

    const pj = pendingJoin();
    let joined = null;
    if (pj) {
      try { sessionStorage.removeItem("pendingJoin"); } catch {}
      const { data, error } = await sb.rpc("join_book", { code: pj });
      if (error) toast(errText(error)); else { joined = data; toast("Ти приєднався до книги"); }
    }
    await loadBooks(joined);
  }

  async function loadBooks(preferId) {
    const { data, error } = await sb.from("book_members")
      .select("role, books(id, name, owner_id, invite_code, created_at)")
      .eq("user_id", S.user.id);
    if (error) { toast(errText(error)); return; }
    S.books = (data || []).filter((r) => r.books).map((r) => ({ ...r.books, role: r.role }))
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (!S.books.length) {
      const { error: e2 } = await sb.from("books").insert({ name: "Мій облік", owner_id: S.user.id });
      if (e2) { toast(errText(e2)); return; }
      return loadBooks();
    }
    let last = null; try { last = localStorage.getItem("book"); } catch {}
    const pick = [preferId, S.bookId, last].find((id) => id && S.books.some((b) => b.id === id)) || S.books[0].id;
    renderBooks();
    await openBook(pick);
  }

  async function openBook(id) {
    S.bookId = id; S.contactId = ""; S.editingOp = null;
    try { localStorage.setItem("book", id); } catch {}
    const b = S.books.find((x) => x.id === id); S.role = b?.role;
    $("bookSelect").value = id;
    await reloadData();
    subscribe(id);
    resetOpForm(true);
  }

  async function reloadData() {
    const id = S.bookId; if (!id) return;
    const [c, o, m] = await Promise.all([
      sb.from("contacts").select("*").eq("book_id", id).order("name"),
      sb.from("ops").select("*").eq("book_id", id).order("op_date", { ascending: false }).order("created_at", { ascending: false }),
      sb.from("book_members").select("user_id, role, joined_at").eq("book_id", id),
    ]);
    if (id !== S.bookId) return;
    for (const r of [c, o, m]) if (r.error) { toast(errText(r.error)); return; }
    S.contacts = c.data.map((x) => ({ ...x, rate: x.rate == null ? null : Number(x.rate) }));
    S.ops = o.data.map((x) => ({ ...x, uah: Number(x.uah), usdt: Number(x.usdt), rate: x.rate == null ? null : Number(x.rate) }));
    S.members = m.data;
    const ids = [...new Set([...S.members.map((x) => x.user_id), ...S.ops.map((x) => x.created_by).filter(Boolean)])];
    if (ids.length) {
      const { data: profs } = await sb.from("profiles").select("id, display_name").in("id", ids);
      for (const p of profs || []) S.profiles[p.id] = p.display_name;
    }
    if (S.contactId && !S.contacts.some((x) => x.id === S.contactId)) S.contactId = "";
    renderAll();
  }

  function subscribe(id) {
    if (S.channel) sb.removeChannel(S.channel);
    const again = () => { clearTimeout(S.reloadTimer); S.reloadTimer = setTimeout(reloadData, 400); };
    S.channel = sb.channel("book-" + id)
      .on("postgres_changes", { event: "*", schema: "public", table: "ops", filter: "book_id=eq." + id }, again)
      .on("postgres_changes", { event: "*", schema: "public", table: "contacts", filter: "book_id=eq." + id }, again)
      .on("postgres_changes", { event: "*", schema: "public", table: "book_members", filter: "book_id=eq." + id }, again)
      .subscribe();
  }
  document.addEventListener("visibilitychange", () => { if (!document.hidden && S.bookId) reloadData(); });

  // ---------- Розрахунки ----------
  function inPeriod(d) {
    const now = new Date(), pad = (n) => String(n).padStart(2, "0");
    const ym = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}`;
    if (S.period === "month") return d.startsWith(ym(now));
    if (S.period === "prev") return d.startsWith(ym(new Date(now.getFullYear(), now.getMonth() - 1, 1)));
    if (S.period === "custom") return (!S.from || d >= S.from) && (!S.to || d <= S.to);
    return true;
  }
  const visibleOps = () => S.ops.filter((o) => inPeriod(o.op_date) && (!S.contactId || o.contact_id === S.contactId));
  function balanceOf(contactId) {
    let usdt = 0, uah = 0, n = 0;
    for (const o of S.ops) if (o.contact_id === contactId) { const s = KINDS[o.kind].sign; usdt += s * o.usdt; uah += s * o.uah; n++; }
    return { usdt, uah, n };
  }
  const contactName = (id) => S.contacts.find((c) => c.id === id)?.name || "—";
  const isMine = (o) => o.created_by === S.user.id || S.role === "owner";
  function balWords(usdt) {
    if (usdt > 0.004) return { cls: "pos", word: "винен тобі" };
    if (usdt < -0.004) return { cls: "neg", word: "ти винен" };
    return { cls: "", word: "розраховані" };
  }

  // ---------- Рендер ----------
  function renderAll() {
    renderBooks(); renderSummary(); renderPeople(); renderContactSelect(); renderContactCard(); renderOps(); updateRateLine();
    $("membersCount").textContent = S.members.length > 1 ? S.members.length : "";
  }

  function renderUser() {
    const n = S.profile.display_name || S.user.email;
    $("userName").textContent = n;
    const a = $("userAvatar"); a.textContent = initial(n); a.style.background = colorFor(S.user.id);
  }

  function renderBooks() {
    const sel = $("bookSelect"); sel.replaceChildren();
    for (const b of S.books) sel.append(el("option", { value: b.id, text: b.name + (b.role === "owner" ? "" : " · спільна") }));
    if (S.bookId) sel.value = S.bookId;
  }

  function renderSummary() {
    const list = visibleOps();
    let uahOut = 0, usdtIn = 0, nU = 0, nT = 0, sumUah = 0, sumUsdt = 0;
    for (const o of list) {
      if (o.kind === "uah_out") { uahOut += o.uah; nU++; }
      if (o.kind === "usdt_in") { usdtIn += o.usdt; nT++; }
      if (o.usdt > 0) { sumUah += o.uah; sumUsdt += o.usdt; }
    }
    $("sUah").textContent = uahS(uahOut);
    $("sUahN").textContent = nU ? `${nU} операц.` : "немає операцій";
    $("sUsdt").textContent = usdtS(usdtIn);
    $("sUsdtN").textContent = nT ? `${nT} операц.` : "немає операцій";
    $("sRate").textContent = sumUsdt > 0 ? fUah.format(sumUah / sumUsdt) : "—";

    let bal = 0, owers = 0;
    const scope = S.contactId ? S.contacts.filter((c) => c.id === S.contactId) : S.contacts;
    for (const c of scope) { const b = balanceOf(c.id).usdt; bal += b; if (Math.abs(b) > 0.004) owers++; }
    const w = balWords(bal);
    $("sBalK").textContent = S.contactId ? `Баланс · ${contactName(S.contactId)}` : (bal > 0.004 ? "Тобі винні разом" : bal < -0.004 ? "Ти винен разом" : "Баланс");
    $("sBal").textContent = usdtS(Math.abs(bal));
    $("sBal").className = "tile-v " + w.cls;
    $("sBalS").textContent = S.contactId ? w.word : (owers ? `незакритих рахунків: ${owers}` : "усі розраховані");
  }

  function renderPeople() {
    const box = $("peopleList"); box.replaceChildren();
    $("allPeople").setAttribute("aria-pressed", String(!S.contactId));
    $("allCount").textContent = S.contacts.length ? String(S.contacts.length) : "";
    if (!S.contacts.length) {
      box.append(el("p", { class: "empty-side", text: "Додай людину, з якою міняєш гривні на USDT." }));
      return;
    }
    const rows = S.contacts.map((c) => ({ c, b: balanceOf(c.id) }))
      .sort((x, y) => Math.abs(y.b.usdt) - Math.abs(x.b.usdt) || x.c.name.localeCompare(y.c.name, "uk"));
    for (const { c, b } of rows) {
      const w = balWords(b.usdt);
      box.append(el("button", {
        type: "button", class: "person", "aria-pressed": String(S.contactId === c.id),
        onclick: () => selectContact(S.contactId === c.id ? "" : c.id),
      },
        el("span", { class: "p-name", text: c.name }),
        el("span", { class: "p-bal " + w.cls }, Math.abs(b.usdt) > 0.004 ? signed(b.usdt, usdtS) : "0 ₮", el("small", { text: w.word })),
        el("span", { class: "p-sub", text: c.rate ? `курс ${fRate.format(c.rate)}` : "курс не задано" })));
    }
  }

  function selectContact(id) {
    S.contactId = id;
    if (id) { $("opContact").value = id; onContactChange(); }
    renderAll();
  }
  $("allPeople").addEventListener("click", () => selectContact(""));

  function renderContactCard() {
    const box = $("contactCard"); box.replaceChildren();
    const c = S.contacts.find((x) => x.id === S.contactId);
    box.hidden = !c; if (!c) return;
    const b = balanceOf(c.id), w = balWords(b.usdt);
    const rate = c.rate || (b.usdt ? Math.abs(b.uah / b.usdt) : null);
    box.append(
      el("div", {}, el("h3", { text: c.name }),
        el("div", { class: "cc-sub", text: `${b.n} операц. · звичайний курс: ${c.rate ? fRate.format(c.rate) + " ₴/₮" : "не задано"}` })),
      el("div", {},
        el("div", { class: "cc-bal " + w.cls, text: Math.abs(b.usdt) > 0.004 ? usdtS(Math.abs(b.usdt)) : "0 ₮" }),
        el("div", { class: "cc-sub", style: "text-align:right", text: w.word + (Math.abs(b.usdt) > 0.004 && rate ? ` · ≈ ${uahS(Math.abs(b.usdt) * rate)}` : "") })),
      el("div", { class: "cc-actions" },
        Math.abs(b.usdt) > 0.004 ? el("button", { class: "btn primary sm", type: "button", text: b.usdt > 0 ? "Записати повернення боргу" : "Записати мою виплату", onclick: () => settle(c, b) }) : null,
        el("button", { class: "btn ghost sm", type: "button", text: "Змінити людину", onclick: () => editContact(c) })));
  }

  function settle(c, b) {
    resetOpForm(false);
    setKind(b.usdt > 0 ? "usdt_in" : "usdt_out");
    $("opContact").value = c.id;
    $("fUsdt").value = plain(Math.abs(b.usdt), 6);
    S.edited = ["usdt"];
    $("fRate").value = c.rate ? plain(c.rate, 4) : "";
    recompute();
    $("opForm").scrollIntoView({ behavior: "smooth", block: "start" });
    $("fUah").focus();
  }

  function dayTitle(d) {
    const dt = new Date(d + "T12:00:00");
    const t = today(), y = new Date(Date.now() - 864e5).toLocaleDateString("sv");
    if (d === t) return "Сьогодні";
    if (d === y) return "Вчора";
    return dt.toLocaleDateString("uk-UA", { day: "numeric", month: "long", year: "numeric" });
  }

  function renderOps() {
    const box = $("opsList"); box.replaceChildren();
    const list = visibleOps();
    if (!list.length) {
      box.append(el("div", { class: "empty" },
        el("span", { class: "glyph", text: "₴ ⇄ ₮" }),
        el("b", { text: S.ops.length ? "За цей період операцій немає" : "Ще немає жодної операції" }),
        el("span", { text: S.ops.length ? "Зміни період або вибери іншу людину." : (S.contacts.length ? "Заповни форму вище: скільки гривень дав або скільки USDT отримав." : "Почни з того, що додаси людину зліва, а потім запиши першу операцію.") })));
      return;
    }
    const multi = S.members.length > 1;
    let lastDay = "";
    for (const o of list) {
      if (o.op_date !== lastDay) { lastDay = o.op_date; box.append(el("div", { class: "day", text: dayTitle(o.op_date) })); }
      const k = KINDS[o.kind];
      const isUah = k.asset === "uah";
      const main = isUah ? (k.sign > 0 ? "−" : "+") + uahS(o.uah) : (k.sign > 0 ? "−" : "+") + usdtS(o.usdt);
      const second = isUah ? `= ${usdtS(o.usdt)}` : `= ${uahS(o.uah)}`;
      const meta = [o.method, o.method_detail, o.note].filter(Boolean).join(" · ");
      const author = S.profiles[o.created_by];
      const acts = el("div", { class: "op-acts" });
      if (isMine(o)) {
        acts.append(el("button", { type: "button", text: "Змінити", onclick: () => editOp(o) }));
        const del = el("button", { type: "button", text: "Видалити" });
        let armed = false, t;
        del.addEventListener("click", async () => {
          if (!armed) { armed = true; del.textContent = "Точно видалити?"; del.classList.add("armed"); t = setTimeout(() => { armed = false; del.textContent = "Видалити"; del.classList.remove("armed"); }, 3000); return; }
          clearTimeout(t); del.disabled = true;
          const { error } = await sb.from("ops").delete().eq("id", o.id);
          if (error) { toast(errText(error)); del.disabled = false; return; }
          toast("Операцію видалено"); reloadData();
        });
        acts.append(del);
      }
      box.append(el("div", { class: "op" },
        el("span", { class: "op-ic " + k.asset, text: isUah ? "₴" : "₮" }),
        el("div", { class: "op-main" },
          el("b", { text: `${k.title} · ${contactName(o.contact_id)}` }),
          el("div", { class: "op-meta" },
            meta || null,
            multi && author ? el("span", { class: "by" }, meta ? " · " : "", avatar(o.created_by, author), author) : null)),
        el("div", { class: "op-amt" },
          el("div", { class: "a1 " + (k.sign > 0 ? "neg" : "pos"), text: main }),
          el("div", { class: "a2", text: `${second} · курс ${o.rate ? fRate.format(o.rate) : "—"}` })),
        acts));
    }
  }

  // ---------- Люди: додати / змінити ----------
  function openContactForm(c) {
    S.editingContact = c || null;
    $("contactForm").hidden = false;
    $("cName").value = c ? c.name : "";
    $("cRate").value = c && c.rate ? plain(c.rate, 4) : "";
    $("cSave").textContent = c ? "Зберегти" : "Додати";
    $("cDelete").hidden = !c || !(c.created_by === S.user.id || S.role === "owner");
    $("cDelete").textContent = "Видалити";
    $("cName").focus();
  }
  function editContact(c) { openContactForm(c); $("contactForm").scrollIntoView({ behavior: "smooth", block: "nearest" }); }
  $("addContactBtn").addEventListener("click", () => openContactForm(null));
  $("cCancel").addEventListener("click", () => { $("contactForm").hidden = true; });
  $("contactForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("cName").value.trim();
    const r = parseNum($("cRate").value);
    if (!name) return;
    const rate = isNaN(r) || r <= 0 ? null : r;
    const btn = $("cSave"); btn.disabled = true;
    const q = S.editingContact
      ? sb.from("contacts").update({ name, rate }).eq("id", S.editingContact.id).select().single()
      : sb.from("contacts").insert({ name, rate, book_id: S.bookId, created_by: S.user.id }).select().single();
    const { data, error } = await q;
    btn.disabled = false;
    if (error) { toast(errText(error)); return; }
    $("contactForm").hidden = true;
    toast(S.editingContact ? "Збережено" : `${name} додано`);
    await reloadData();
    selectContact(data.id);
  });
  let cDelArmed = false;
  $("cDelete").addEventListener("click", async () => {
    const c = S.editingContact; if (!c) return;
    if (!cDelArmed) {
      cDelArmed = true; $("cDelete").textContent = `Видалити разом з ${balanceOf(c.id).n} операц.?`;
      setTimeout(() => { cDelArmed = false; $("cDelete").textContent = "Видалити"; }, 4000); return;
    }
    cDelArmed = false;
    const { error } = await sb.from("contacts").delete().eq("id", c.id);
    if (error) { toast(errText(error)); return; }
    $("contactForm").hidden = true; toast("Людину видалено"); S.contactId = ""; reloadData();
  });

  // ---------- Форма операції ----------
  function currentKind() { return document.querySelector('input[name="kind"]:checked').value; }
  function setKind(k) {
    const r = document.querySelector(`input[name="kind"][value="${k}"]`); r.checked = true;
    if (k === "usdt_out" || k === "uah_in") r.closest("details").open = true;
    onKindChange();
  }
  function onKindChange() {
    const k = KINDS[currentKind()];
    const sel = $("opMethod"), prev = sel.value; sel.replaceChildren();
    for (const m of METHODS[k.asset]) sel.append(el("option", { value: m, text: m }));
    if (METHODS[k.asset].includes(prev)) sel.value = prev;
    const out = k.sign > 0;
    $("methodLabel").textContent = k.asset === "uah" ? (out ? "Як передав" : "Як отримав") : "Мережа / спосіб";
    $("detailLabel").textContent = k.asset === "uah" ? "Карта / банк" : "Гаманець / біржа";
    $("opDetail").placeholder = k.asset === "uah" ? "Моно, ****1234" : "Binance, TXx…";
    const dl = $("detailList"); dl.replaceChildren();
    const used = new Set(S.ops.filter((o) => KINDS[o.kind].asset === k.asset && o.method_detail).map((o) => o.method_detail));
    for (const d of used) dl.append(el("option", { value: d }));
    updateRateLine();
  }
  document.querySelectorAll('input[name="kind"]').forEach((r) => r.addEventListener("change", onKindChange));

  function renderContactSelect() {
    const sel = $("opContact"), prev = sel.value; sel.replaceChildren();
    if (!S.contacts.length) sel.append(el("option", { value: "", text: "Спершу додай людину" }));
    else sel.append(el("option", { value: "", text: "Вибери людину…" }));
    for (const c of S.contacts) sel.append(el("option", { value: c.id, text: c.name }));
    sel.append(el("option", { value: "__new", text: "+ Нова людина…" }));
    const want = S.contactId || prev;
    if (want && S.contacts.some((c) => c.id === want)) sel.value = want;
  }
  function onContactChange() {
    const v = $("opContact").value;
    if (v === "__new") { $("opContact").value = ""; openContactForm(null); return; }
    const c = S.contacts.find((x) => x.id === v);
    if (!S.edited.includes("rate")) { $("fRate").value = c && c.rate ? plain(c.rate, 4) : ""; }
    recompute();
  }
  $("opContact").addEventListener("change", onContactChange);

  // Автокурс: будь-які два з трьох полів → третє рахується
  const FIELDS = { uah: "fUah", usdt: "fUsdt", rate: "fRate" };
  function vals() { return { uah: parseNum($("fUah").value), usdt: parseNum($("fUsdt").value), rate: parseNum($("fRate").value) }; }
  function setAuto(f) {
    S.autoField = f;
    for (const k of Object.keys(FIELDS)) document.querySelector(`.amt[data-f="${k}"]`).classList.toggle("auto", k === f);
  }
  function recompute() {
    const v = vals(), ok = (x) => !isNaN(x) && x > 0;
    let src = S.edited.filter((f) => ok(v[f])).slice(0, 2);
    if (src.length < 2 && !src.includes("rate") && ok(v.rate) && S.autoField !== "rate") src.push("rate");
    if (src.length >= 2) {
      const t = ["uah", "usdt", "rate"].find((f) => !src.includes(f));
      let out = NaN;
      if (t === "rate") out = v.uah / v.usdt;
      if (t === "usdt") out = v.uah / v.rate;
      if (t === "uah") out = v.usdt * v.rate;
      if (isFinite(out) && out > 0) {
        $(FIELDS[t]).value = plain(out, t === "uah" ? 2 : t === "usdt" ? 2 : 4);
        setAuto(t);
      }
    } else if (S.autoField) {
      $(FIELDS[S.autoField]).value = ""; setAuto(null);
    }
    updateRateLine();
  }
  for (const [f, id] of Object.entries(FIELDS)) {
    $(id).addEventListener("input", () => {
      S.edited = [f, ...S.edited.filter((x) => x !== f)];
      if (S.autoField === f) setAuto(null);
      recompute();
    });
  }

  function updateRateLine() {
    const v = vals(), line = $("rateLine"); line.replaceChildren();
    if (v.uah > 0 && v.usdt > 0) {
      const rate = v.uah / v.usdt;
      const c = S.contacts.find((x) => x.id === $("opContact").value);
      line.append("Курс операції: ", el("b", { text: fRate.format(rate) }), " ₴ за 1 USDT · ",
        el("span", { class: "num", text: `${uahS(v.uah)} = ${usdtS(v.usdt)}` }));
      if (c && c.rate && Math.abs(rate - c.rate) >= 0.005) {
        const d = rate - c.rate;
        line.append(el("br"), el("span", { class: "diff " + (d > 0 ? "neg" : "pos"), text: `${d > 0 ? "+" : "−"}${fRate.format(Math.abs(d))} ₴` }),
          ` від звичайного курсу з цією людиною (${fRate.format(c.rate)})`);
      }
    } else {
      line.append("Введи будь-які два числа: суму в гривнях, суму в USDT або курс. Третє програма порахує сама.");
    }
  }

  function resetOpForm(full) {
    S.editingOp = null; S.edited = []; setAuto(null);
    $("fUah").value = ""; $("fUsdt").value = ""; $("opNote").value = "";
    if (full) { $("opDetail").value = ""; $("opDate").value = today(); }
    $("opTitle").textContent = "Нова операція"; $("opSave").textContent = "Записати операцію"; $("cancelEdit").hidden = true;
    onKindChange(); onContactChange();
  }
  $("cancelEdit").addEventListener("click", () => { resetOpForm(true); setMsg("opMsg", ""); });

  function editOp(o) {
    S.editingOp = o;
    setKind(o.kind);
    $("opContact").value = o.contact_id;
    $("fUah").value = plain(o.uah, 2); $("fUsdt").value = plain(o.usdt, 6);
    S.edited = ["uah", "usdt"]; setAuto(null); $("fRate").value = ""; recompute();
    $("opMethod").value = o.method || $("opMethod").value; $("opDetail").value = o.method_detail || "";
    $("opDate").value = o.op_date; $("opNote").value = o.note || "";
    $("opTitle").textContent = "Редагування операції"; $("opSave").textContent = "Зберегти зміни"; $("cancelEdit").hidden = false;
    $("opForm").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("opForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = vals(), contact_id = $("opContact").value;
    if (!contact_id || contact_id === "__new") { setMsg("opMsg", "Вибери людину.", "err"); return; }
    if (!(v.uah > 0 && v.usdt > 0)) { setMsg("opMsg", "Потрібні обидві суми: введи суму і курс, або суму в гривнях і в USDT.", "err"); return; }
    if (!$("opDate").value) { setMsg("opMsg", "Вкажи дату.", "err"); return; }
    const row = {
      kind: currentKind(), contact_id,
      uah: Math.round(v.uah * 100) / 100, usdt: Math.round(v.usdt * 1e6) / 1e6,
      method: $("opMethod").value, method_detail: $("opDetail").value.trim(),
      op_date: $("opDate").value, note: $("opNote").value.trim(),
    };
    const btn = $("opSave"); btn.disabled = true;
    const editing = S.editingOp;
    const { error } = editing
      ? await sb.from("ops").update(row).eq("id", editing.id)
      : await sb.from("ops").insert({ ...row, book_id: S.bookId, created_by: S.user.id });
    btn.disabled = false;
    if (error) { setMsg("opMsg", errText(error), "err"); return; }
    setMsg("opMsg", "");
    const c = S.contacts.find((x) => x.id === contact_id);
    if (c && !c.rate) {
      await sb.from("contacts").update({ rate: Math.round((row.uah / row.usdt) * 1e4) / 1e4 }).eq("id", c.id);
      toast(`Записано. Курс ${fRate.format(row.uah / row.usdt)} збережено як звичайний для ${c.name}`);
    } else toast(editing ? "Зміни збережено" : "Операцію записано");
    resetOpForm(false);
    await reloadData();
  });

  // ---------- Фільтри ----------
  document.querySelectorAll("[data-period]").forEach((b) => b.addEventListener("click", () => {
    S.period = b.dataset.period;
    document.querySelectorAll("[data-period]").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
    $("rangeBox").hidden = S.period !== "custom";
    renderAll();
  }));
  $("fromDate").addEventListener("change", (e) => { S.from = e.target.value; renderAll(); });
  $("toDate").addEventListener("change", (e) => { S.to = e.target.value; renderAll(); });

  // ---------- CSV ----------
  $("exportBtn").addEventListener("click", () => {
    const list = visibleOps();
    if (!list.length) { toast("Немає операцій для експорту"); return; }
    const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
    const num = (n, d) => String(Number(n.toFixed(d))).replace(".", ",");
    const lines = [["Дата", "Тип", "Людина", "Гривні", "USDT", "Курс", "Спосіб", "Деталі", "Коментар", "Хто записав"].map(q).join(";")];
    for (const o of list) lines.push([o.op_date, KINDS[o.kind].title, contactName(o.contact_id), num(o.uah, 2), num(o.usdt, 6),
      o.rate ? num(o.rate, 4) : "", o.method, o.method_detail, o.note, S.profiles[o.created_by] || ""].map(q).join(";"));
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = el("a", { href: URL.createObjectURL(blob), download: `kripto-oblik-${today()}.csv` });
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });

  // ---------- Книги та учасники ----------
  $("bookSelect").addEventListener("change", (e) => openBook(e.target.value));
  const curBook = () => S.books.find((b) => b.id === S.bookId);
  const inviteLink = (b) => baseUrl() + "?join=" + b.invite_code;

  function renderMembersDlg() {
    const b = curBook(); if (!b) return;
    const owner = S.role === "owner";
    $("bookName").value = b.name; $("bookName").disabled = !owner; $("renameBtn").hidden = !owner;
    $("inviteCode").textContent = b.invite_code;
    $("rotateBtn").hidden = !owner;
    $("leaveBtn").hidden = owner;
    const ul = $("membersList"); ul.replaceChildren();
    for (const m of S.members.slice().sort((x, y) => (x.role === "owner" ? -1 : 1) - (y.role === "owner" ? -1 : 1))) {
      const name = S.profiles[m.user_id] || "Учасник";
      ul.append(el("li", {}, avatar(m.user_id, name),
        el("span", { class: "m-name", text: name + (m.user_id === S.user.id ? " (ти)" : "") }),
        el("span", { class: "m-role", text: m.role === "owner" ? "власник" : "учасник" }),
        owner && m.role !== "owner" ? el("button", { class: "link", type: "button", text: "Прибрати", onclick: async () => {
          const { error } = await sb.from("book_members").delete().eq("book_id", b.id).eq("user_id", m.user_id);
          if (error) { setMsg("dlgMsg", errText(error), "err"); return; }
          await reloadData(); renderMembersDlg();
        } }) : null));
    }
    setMsg("dlgMsg", "");
  }
  $("membersBtn").addEventListener("click", () => { renderMembersDlg(); $("membersDlg").showModal(); });
  $("copyLink").addEventListener("click", () => copyText(inviteLink(curBook())));
  $("copyCode").addEventListener("click", () => copyText(curBook().invite_code));
  $("rotateBtn").addEventListener("click", async () => {
    const { data, error } = await sb.rpc("rotate_invite", { b: S.bookId });
    if (error) { setMsg("dlgMsg", errText(error), "err"); return; }
    curBook().invite_code = data; renderMembersDlg(); setMsg("dlgMsg", "Старий код більше не працює.", "ok");
  });
  $("renameBtn").addEventListener("click", async () => {
    const name = $("bookName").value.trim(); if (!name) return;
    const { error } = await sb.from("books").update({ name }).eq("id", S.bookId);
    if (error) { setMsg("dlgMsg", errText(error), "err"); return; }
    curBook().name = name; renderBooks(); setMsg("dlgMsg", "Назву змінено.", "ok");
  });
  $("joinBtn").addEventListener("click", async () => {
    const code = $("joinCode").value.trim(); if (!code) return;
    const { data, error } = await sb.rpc("join_book", { code });
    if (error) { setMsg("dlgMsg", errText(error), "err"); return; }
    $("joinCode").value = ""; $("membersDlg").close(); toast("Ти приєднався до книги");
    await loadBooks(data);
  });
  $("newBookBtn").addEventListener("click", async () => {
    const name = $("newBookName").value.trim(); if (!name) return;
    const { data, error } = await sb.from("books").insert({ name, owner_id: S.user.id }).select("id").single();
    if (error) { setMsg("dlgMsg", errText(error), "err"); return; }
    $("newBookName").value = ""; $("membersDlg").close(); toast("Книгу створено");
    await loadBooks(data.id);
  });
  let leaveArmed = false;
  $("leaveBtn").addEventListener("click", async () => {
    if (!leaveArmed) { leaveArmed = true; $("leaveBtn").textContent = "Точно вийти? Натисни ще раз"; setTimeout(() => { leaveArmed = false; $("leaveBtn").textContent = "Вийти з книги"; }, 4000); return; }
    leaveArmed = false;
    const { error } = await sb.from("book_members").delete().eq("book_id", S.bookId).eq("user_id", S.user.id);
    if (error) { setMsg("dlgMsg", errText(error), "err"); return; }
    $("membersDlg").close(); S.bookId = null; toast("Ти вийшов з книги");
    await loadBooks();
  });

  // ---------- Акаунт ----------
  $("userBtn").addEventListener("click", () => {
    $("userEmail").textContent = S.user.email; $("profName").value = S.profile.display_name || ""; setMsg("userMsg", "");
    $("userDlg").showModal();
  });
  $("profSave").addEventListener("click", async () => {
    const display_name = $("profName").value.trim(); if (!display_name) return;
    const { error } = await sb.from("profiles").update({ display_name }).eq("id", S.user.id);
    if (error) { setMsg("userMsg", errText(error), "err"); return; }
    S.profile.display_name = display_name; S.profiles[S.user.id] = display_name; renderUser(); renderOps();
    setMsg("userMsg", "Збережено.", "ok");
  });
  $("logoutBtn").addEventListener("click", async () => { $("userDlg").close(); await sb.auth.signOut(); });

  // ---------- Застосунок на телефоні (PWA) ----------
  const isStandalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  let installEvt = null;
  const installBtns = () => document.querySelectorAll("[data-install]");
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); installEvt = e;
    installBtns().forEach((b) => (b.hidden = false));
  });
  window.addEventListener("appinstalled", () => {
    installEvt = null; installBtns().forEach((b) => (b.hidden = true)); toast("Застосунок встановлено");
  });
  installBtns().forEach((b) => b.addEventListener("click", async () => {
    if (!installEvt) return;
    installEvt.prompt();
    await installEvt.userChoice.catch(() => null);
    installEvt = null; installBtns().forEach((x) => (x.hidden = true));
  }));

  // iPhone / iPad: кнопки встановлення немає, показуємо підказку
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let hintOff = false; try { hintOff = localStorage.getItem("iosHintOff") === "1"; } catch {}
  if (isIOS && !isStandalone() && !hintOff) $("iosHint").hidden = false;
  $("iosHintClose").addEventListener("click", () => {
    $("iosHint").hidden = true; try { localStorage.setItem("iosHintOff", "1"); } catch {}
  });

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }

  // Без інтернету
  const syncOnline = () => { $("offlineBar").hidden = navigator.onLine; };
  window.addEventListener("online", () => { syncOnline(); if (S.bookId) reloadData(); });
  window.addEventListener("offline", syncOnline);
  syncOnline();

  // Нижня панель на телефоні
  const scrollToEl = (node) => {
    const top = node.getBoundingClientRect().top + window.scrollY - 70;
    window.scrollTo({ top, behavior: "smooth" });
  };
  $("mbAdd").addEventListener("click", () => {
    if (S.editingOp) resetOpForm(true);
    scrollToEl($("opTitle").closest(".panel"));
    setTimeout(() => (KINDS[currentKind()].asset === "uah" ? $("fUah") : $("fUsdt")).focus({ preventScroll: true }), 350);
  });
  $("mbList").addEventListener("click", () => scrollToEl($("listTitle").closest(".panel")));
  $("mbPeople").addEventListener("click", () => scrollToEl($("peopleTitle").closest(".panel")));

  // ---------- Старт ----------
  setAuthMode("login");
  (async () => {
    const { data } = await sb.auth.getSession();
    if (!data.session && !recovering) { teardown(); show("auth"); }
  })();
})();
