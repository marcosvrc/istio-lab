"use strict";

// ---------- estado ----------
const state = {
  catalog: null,
  view: "overview",  // overview | module | exercise
  moduleId: null,
  exIndex: 0,
  tab: null,         // manifests | actions | tests
  status: {},        // moduleId -> [[estado por manifest]]
  statusAt: {},      // moduleId -> Date da última verificação
  loading: new Set(),// módulos com status sendo verificado
  cluster: null,
  dashboards: [],
  expanded: new Set(),
  params: {},        // "mod/ex/mf" -> {nome: valor}
  outputs: {},       // chave -> {ok, text}
  results: {},       // "mod/ex/test" -> resposta do teste
  yaml: {},          // "mod/ex/mf" -> yaml renderizado (quando aberto)
  logAfter: 0,
  log: [],
  logFilter: "all",
};

// estado de um exercício (ou manifest) -> rótulo, ícone e cor
const STATE = {
  applied: { label: "Aplicado", icon: "ok", cls: "ok" },
  modified: { label: "Outra config", icon: "warn", cls: "warn" },
  partial: { label: "Parcial", icon: "warn", cls: "warn" },
  absent: { label: "Não aplicado", icon: "off", cls: "muted" },
  error: { label: "Erro / CRD ausente", icon: "err", cls: "bad" },
  none: { label: "Sem manifests", icon: "dash", cls: "muted" },
  unknown: { label: "Não verificado", icon: "off", cls: "muted" },
  loading: { label: "Verificando…", icon: "spin", cls: "muted" },
};

// ---------- ícones (SVG inline, 24×24) ----------
const S = (d, extra = "") => `<path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" ${extra}/>`;
const ICONS = {
  ok: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="m7.5 12.5 3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/>`,
  warn: `<path d="M12 2.8 22.6 21H1.4z" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M12 9.5v5M12 17.8v.1" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`,
  err: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7v6M12 16.6v.1" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`,
  off: `<circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2.2"/>`,
  dash: S("M7 12h10"),
  info: `<circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 11v6M12 7.4v.1" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/>`,
  menu: S("M4 6h16M4 12h16M4 18h16"),
  grid: S("M4 4h6.5v6.5H4zM13.5 4H20v6.5h-6.5zM4 13.5h6.5V20H4zM13.5 13.5H20V20h-6.5z"),
  "chevron-right": S("m9 6 6 6-6 6"),
  "chevron-down": S("m6 9 6 6 6-6"),
  "chevron-left": S("m15 6-6 6 6 6"),
  external: S("M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"),
  terminal: S("m4 17 6-5-6-5M12 19h8"),
  server: S("M4 4h16v7H4zM4 13h16v7H4zM8 7.5h.01M8 16.5h.01"),
  close: S("M6 6l12 12M18 6 6 18"),
  sync: S("M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4"),
  play: `<path d="M7 4.5v15l12-7.5z" fill="currentColor"/>`,
  undo: S("M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"),
  copy: S("M9 9h11v11H9zM5 15H4V4h11v1"),
  file: S("M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8zM14 3v5h5"),
  code: S("m8 8-5 4 5 4M16 8l5 4-5 4"),
  upload: S("M12 16V4M7 9l5-5 5 5M4 20h16"),
  trash: S("M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"),
  eye: S("M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z") + `<circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/>`,
  moon: S("M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"),
  sun: `<circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="2"/>` + S("M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"),
  flask: S("M9 3h6M10 3v6L4.5 19a1 1 0 0 0 .9 1.5h13.2a1 1 0 0 0 .9-1.5L14 9V3M7 15h10"),
  list: S("M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01"),
};

function icon(name, cls = "") {
  if (name === "spin") return h("span", { class: "spinner " + cls, "aria-hidden": "true" });
  return h("span", { class: "icon " + cls, "aria-hidden": "true", html: `<svg viewBox="0 0 24 24">${ICONS[name] || ""}</svg>` });
}

function statusIcon(key, small = false) {
  const s = STATE[key] || STATE.unknown;
  const el = icon(s.icon, `status ${s.cls}${small ? " sm" : ""}`);
  el.title = s.label;
  return el;
}

function stateLabel(key) {
  const s = STATE[key] || STATE.unknown;
  return h("span", { class: "label " + s.cls }, statusIcon(key, true), s.label);
}

// ---------- utilitários ----------
const $ = (sel) => document.querySelector(sel);

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// markdown mínimo: parágrafos, `código` e **negrito**
function md(text) {
  if (!text) return "";
  return text.trim().split(/\n\s*\n/).map((p) =>
    "<p>" + esc(p).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/\n/g, " ") + "</p>"
  ).join("");
}

async function api(path, body) {
  const opts = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  const res = await fetch("/api/" + path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// toast no canto superior direito (info | success | danger)
function toast(msg, kind = "info") {
  const iconName = { success: "ok", danger: "err", info: "info" }[kind];
  const t = h("div", { class: "toast " + kind, role: "status" },
    icon(iconName, "status " + { success: "ok", danger: "bad", info: "info" }[kind]),
    h("div", { class: "grow" }, msg),
    h("button", { class: "btn plain small", "aria-label": "Fechar", onclick: () => t.remove() }, icon("close")));
  $("#toasts").append(t);
  setTimeout(() => t.remove(), kind === "danger" ? 9000 : 5000);
}

// executa uma operação com o botão desabilitado enquanto roda
async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add("running");
  try { return await fn(); }
  catch (e) { toast("Erro: " + e.message, "danger"); }
  finally { btn.disabled = false; btn.classList.remove("running"); pollLog(); }
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast("Copiado para a área de transferência.", "success");
  } catch {
    toast("Não foi possível copiar.", "danger");
  }
}

const mod = (id = state.moduleId) => state.catalog.modules.find((m) => m.id === id);
const keyOf = (...p) => p.join("/");
const num = (m) => m.id.split("-")[0];
const time = (d) => d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------- dropdown / popover ----------
let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.panel.hidden = true;
  openMenu.toggle.setAttribute("aria-expanded", "false");
  openMenu = null;
}

document.addEventListener("click", (e) => {
  if (openMenu && !openMenu.wrap.contains(e.target)) closeMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (openMenu) closeMenu();
  else if (!$("#log").hidden) toggleLog(false);
});

// toggleChildren: conteúdo do botão; panel: elemento ou lista de itens de menu
function dropdown(toggleChildren, panel, { cls = "btn secondary", title, align = "right" } = {}) {
  const wrap = h("div", { class: "dropdown" });
  const toggle = h("button", { class: cls, title, "aria-haspopup": "true", "aria-expanded": "false" }, toggleChildren);
  const content = Array.isArray(panel)
    ? h("div", { class: "menu", role: "menu" }, panel.map((it) => it === "-"
      ? h("hr")
      : h("button", {
        class: "menu-item" + (it.danger ? " danger" : ""), role: "menuitem", title: it.title,
        onclick: () => { closeMenu(); it.onclick(toggle); },
      }, it.icon && icon(it.icon), h("span", {}, it.label, it.desc && h("span", { class: "menu-desc" }, it.desc)))))
    : panel;
  const box = h("div", { class: `popup ${align}`, hidden: true }, content);
  toggle.addEventListener("click", (e) => {
    e.stopPropagation();
    const wasOpen = openMenu && openMenu.wrap === wrap;
    closeMenu();
    if (wasOpen) return;
    box.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    openMenu = { wrap, panel: box, toggle };
  });
  wrap.append(toggle, box);
  return wrap;
}

// ---------- navegação ----------
// #/                    visão geral
// #/<módulo>            lista de exercícios do módulo
// #/<módulo>/<ex>[/tab] exercício
function parseHash() {
  const [, m, e, t] = location.hash.match(/^#\/([^/]+)\/?(\d+)?\/?(\w+)?/) || [];
  const mods = state.catalog.modules;
  if (!m || !mods.some((x) => x.id === m)) {
    state.view = "overview";
    return;
  }
  state.moduleId = m;
  state.expanded.add(m);
  if (e == null) {
    state.view = "module";
    return;
  }
  state.view = "exercise";
  state.exIndex = Math.min(Number(e), mod().exercises.length - 1);
  state.tab = t || null;
}

window.addEventListener("hashchange", () => {
  const prev = state.moduleId;
  const prevView = state.view;
  parseHash();
  closeMenu();
  document.body.classList.remove("nav-open");
  if (state.view === "overview") loadAllStatus(false);
  else if (prev !== state.moduleId || prevView === "overview" || !state.status[state.moduleId]) refreshStatus();
  render();
  if (prevView !== state.view || prev !== state.moduleId) $("#main").scrollTop = 0;
});

// ---------- estado dos exercícios ----------
function exState(moduleId, ei) {
  const all = state.status[moduleId];
  if (!all) return state.loading.has(moduleId) ? "loading" : "unknown";
  const st = all[ei];
  if (!st || st.length === 0) return "none";
  if (st.includes("error")) return "error";
  if (st.every((s) => s === "applied")) return "applied";
  if (st.some((s) => s !== "absent")) return "partial";
  return "absent";
}

function moduleCounts(m) {
  const c = { applied: 0, partial: 0, error: 0, absent: 0 };
  m.exercises.forEach((_, i) => {
    const s = exState(m.id, i);
    if (s in c) c[s]++;
  });
  return c;
}

// ---------- render ----------
function render() {
  renderNav();
  renderMain();
}

function renderNav() {
  const nav = $("#nav");
  const cur = state.view === "overview" ? null : state.moduleId;
  nav.replaceChildren(...[
    h("a", { class: "nav-link" + (state.view === "overview" ? " current" : ""), href: "#/" }, icon("grid"), "Visão geral"),
    h("div", { class: "nav-section" }, "Módulos"),
    state.catalog.modules.map((m) => {
      const open = state.expanded.has(m.id);
      return h("div", { class: "nav-group" + (open ? " open" : "") + (m.id === cur ? " active" : "") },
        h("div", { class: "nav-group-head" + (m.id === cur && state.view === "module" ? " current" : "") },
          h("a", { class: "nav-link", href: `#/${m.id}` }, h("span", { class: "nav-num" }, num(m)), h("span", { class: "grow" }, m.title)),
          h("button", {
            class: "nav-toggle", "aria-expanded": String(open), "aria-label": (open ? "Recolher " : "Expandir ") + m.title,
            onclick: () => { open ? state.expanded.delete(m.id) : state.expanded.add(m.id); renderNav(); },
          }, icon("chevron-right"))),
        open && h("div", { class: "nav-sub" }, m.exercises.map((ex, i) =>
          h("a", {
            class: "nav-sublink" + (m.id === cur && state.view === "exercise" && i === state.exIndex ? " current" : ""),
            href: `#/${m.id}/${i}`,
          }, statusIcon(exState(m.id, i), true), h("span", {}, ex.title)))));
    }),
    state.dashboards.length > 0 && h("div", { class: "nav-section" }, "Observabilidade"),
    state.dashboards.map((d) =>
      h("button", {
        class: "nav-link", title: `abre ${d.label} (port-forward para localhost:${d.port})`,
        onclick: (e) => busy(e.currentTarget, () => openDashboard(d)),
      }, icon("external"), h("span", { class: "grow" }, d.label), h("span", { class: "nav-port" }, ":" + d.port))),
  ].flat(Infinity).filter(Boolean));
}

function renderMain() {
  const main = $("#main");
  const views = { overview: renderOverview, module: renderModule, exercise: renderExercise };
  main.replaceChildren(...views[state.view]().flat(Infinity).filter(Boolean));
}

// cabeçalho de página no estilo Kiali: breadcrumb, título, ações e abas
function pageHeader({ crumbs = [], badge, title, sub, label, summary, right, tabs }) {
  return h("section", { class: "page-header" + (tabs ? " with-tabs" : "") },
    crumbs.length > 0 && h("nav", { class: "breadcrumb", "aria-label": "Caminho" },
      crumbs.map((c, i) => [
        i > 0 && icon("chevron-right", "sep"),
        c.href ? h("a", { href: c.href }, c.text) : h("span", { "aria-current": "page" }, c.text),
      ])),
    h("div", { class: "title-row" },
      h("div", { class: "title" },
        badge && h("span", { class: "kind-badge lg " + (badge.cls || "") , title: badge.title }, badge.text),
        h("h1", {}, title),
        sub && h("span", { class: "muted mono small" }, sub),
        label),
      right && h("div", { class: "toolbar" }, right)),
    summary && h("div", { class: "page-summary", html: md(summary) }),
    tabs && h("div", { class: "tabs", role: "tablist" }, tabs.map((t) =>
      h("a", { class: "tab" + (t.active ? " current" : ""), role: "tab", "aria-selected": String(!!t.active), href: t.href },
        icon(t.icon), t.label, h("span", { class: "count" }, t.count)))),
  );
}

function refreshTool(fn, at) {
  return h("div", { class: "refresh" },
    at && h("span", { class: "muted small" }, "Atualizado às " + time(at)),
    h("button", { class: "btn plain", title: "verificar o estado no cluster", "aria-label": "Atualizar", onclick: (e) => busy(e.currentTarget, fn) }, icon("sync")));
}

function moduleActions(m) {
  const items = [];
  if (m.setup) items.push({ label: "Setup do módulo", desc: `roda ${m.id}/${m.setup}`, icon: "play", onclick: (btn) => runScript(btn, m, "setup") });
  if (m.reset) items.push({ label: "Reset do módulo", desc: `roda ${m.id}/${m.reset}`, icon: "undo", danger: true, onclick: (btn) => runScript(btn, m, "reset") });
  if (!items.length) return null;
  return dropdown(["Ações", icon("chevron-down")], items);
}

// ---------- visão geral ----------
function renderOverview() {
  const mods = state.catalog.modules;
  const total = mods.reduce((n, x) => n + x.exercises.length, 0);
  const ats = Object.values(state.statusAt);
  const at = ats.length ? new Date(Math.max(...ats)) : null;
  return [
    pageHeader({
      title: "Visão geral",
      summary: `${mods.length} módulos · ${total} exercícios. O estado de cada exercício vem da comparação dos manifests com o cluster (\`kubectl diff\`).`,
      right: refreshTool(() => loadAllStatus(true), at),
    }),
    h("div", { class: "page-body" },
      h("div", { class: "grid" }, controlPlaneCard(), mods.map(moduleCard))),
  ];
}

function controlPlaneCard() {
  const c = state.cluster;
  let body;
  if (!c) body = h("div", { class: "card-body muted" }, icon("spin"), " consultando o cluster…");
  else if (!c.reachable) body = h("div", { class: "card-body" }, h("div", { class: "alert danger inline" }, statusIcon("error"), h("div", {}, h("strong", {}, "Cluster inacessível"), h("div", { class: "small" }, c.error || ""))));
  else {
    body = [
      h("dl", { class: "props" },
        h("dt", {}, "Contexto"), h("dd", {}, c.context),
        h("dt", {}, "Versão"), h("dd", {}, "Istio " + (c.istio || "?")),
        h("dt", {}, "Modo"), h("dd", {}, c.ambient ? "ambient (ztunnel presente)" : "sidecar")),
      h("ul", { class: "components" }, c.components.map((x) =>
        h("li", {}, statusIcon(x.ready >= x.desired ? "applied" : "partial", true), h("span", { class: "grow mono" }, x.name), h("span", { class: "muted small" }, `${x.ready}/${x.desired}`)))),
    ];
  }
  const ok = c && c.reachable && c.components.every((x) => x.ready >= x.desired);
  return h("article", { class: "card cp-card" },
    h("div", { class: "card-title" },
      h("span", { class: "kind-badge lg net" }, "CP"),
      h("div", { class: "grow" }, h("h2", {}, "Plano de controle"), h("div", { class: "muted small mono" }, "istio-system")),
      c && c.reachable && stateLabel(ok ? "applied" : "partial")),
    body);
}

function moduleCard(m) {
  const c = moduleCounts(m);
  const loading = !state.status[m.id];
  return h("article", { class: "card mod-card" },
    h("div", { class: "card-title" },
      h("span", { class: "kind-badge lg mod" }, num(m)),
      h("div", { class: "grow" }, h("h2", {}, h("a", { href: `#/${m.id}` }, m.title)), h("div", { class: "muted small mono" }, m.id))),
    h("div", { class: "card-body clamp", html: md(m.summary) }),
    h("div", { class: "card-foot" },
      h("a", { href: `#/${m.id}`, class: "stat" }, h("strong", {}, m.exercises.length), " exercícios"),
      h("div", { class: "stat-icons" },
        loading
          ? [statusIcon(state.loading.has(m.id) ? "loading" : "unknown", true), h("span", { class: "muted small" }, state.loading.has(m.id) ? "verificando…" : "não verificado")]
          : ["applied", "partial", "error", "absent"].filter((k) => c[k] > 0).map((k) =>
            h("span", { class: "stat-icon", title: `${c[k]} ${STATE[k].label.toLowerCase()}` }, statusIcon(k, true), c[k])))));
}

// ---------- módulo ----------
function renderModule() {
  const m = mod();
  return [
    pageHeader({
      crumbs: [{ text: "Visão geral", href: "#/" }, { text: `${num(m)} · ${m.title}` }],
      badge: { text: num(m), cls: "mod", title: "módulo" },
      title: m.title,
      sub: m.id,
      summary: m.summary,
      right: [refreshTool(() => refreshStatus(m.id), state.statusAt[m.id]), moduleActions(m)],
    }),
    h("div", { class: "page-body" },
      outputAlert(keyOf("script", m.id)),
      h("div", { class: "card flush" },
        h("table", { class: "table" },
          h("thead", {}, h("tr", {},
            h("th", {}, "Estado"), h("th", {}, "Exercício"), h("th", {}, "Recursos"),
            h("th", { class: "num" }, "Comandos"), h("th", { class: "num" }, "Testes"))),
          h("tbody", {}, m.exercises.map((ex, i) => {
            const res = ex.manifests.flatMap((mf) => mf.resources);
            return h("tr", { class: "clickable", onclick: (e) => { if (!e.target.closest("a")) location.hash = `#/${m.id}/${i}`; } },
              h("td", { class: "nowrap" }, stateLabel(exState(m.id, i))),
              h("td", {}, h("a", { href: `#/${m.id}/${i}` }, ex.title)),
              h("td", {}, res.length ? h("div", { class: "res-list" }, res.slice(0, 4).map(resourceTag), res.length > 4 && h("span", { class: "muted small" }, `+${res.length - 4}`)) : h("span", { class: "muted" }, "—")),
              h("td", { class: "num" }, ex.actions.length || h("span", { class: "muted" }, "—")),
              h("td", { class: "num" }, ex.tests.length || h("span", { class: "muted" }, "—")));
          }))))),
  ];
}

// ---------- exercício ----------
const TABS = [
  { id: "manifests", label: "Manifests", icon: "file", items: (ex) => ex.manifests },
  { id: "actions", label: "Comandos", icon: "terminal", items: (ex) => ex.actions },
  { id: "tests", label: "Testes", icon: "flask", items: (ex) => ex.tests },
];

function renderExercise() {
  const m = mod();
  const ei = state.exIndex;
  const ex = m.exercises[ei];
  const tabs = TABS.filter((t) => t.items(ex).length > 0);
  const tab = tabs.find((t) => t.id === state.tab) || tabs[0];
  const base = `#/${m.id}/${ei}`;
  const prev = ei > 0 && m.exercises[ei - 1];
  const next = ei < m.exercises.length - 1 && m.exercises[ei + 1];

  let body;
  if (!tab) body = h("div", { class: "empty" }, "Este exercício não tem manifests, comandos nem testes no console. Siga o README do módulo.");
  else if (tab.id === "manifests") body = ex.manifests.map((mf, i) => manifestCard(m, ex, i, mf));
  else if (tab.id === "actions") body = ex.actions.map((a, i) => actionCard(m, i, a));
  else body = ex.tests.map((t, i) => testCard(m, i, t));

  return [
    pageHeader({
      crumbs: [{ text: "Visão geral", href: "#/" }, { text: `${num(m)} · ${m.title}`, href: `#/${m.id}` }, { text: ex.title }],
      badge: { text: "EX", cls: "ex", title: "exercício" },
      title: ex.title,
      label: ex.manifests.length > 0 && stateLabel(exState(m.id, ei)),
      summary: ex.summary,
      right: [
        refreshTool(() => refreshStatus(m.id), state.statusAt[m.id]),
        h("div", { class: "pager" },
          h("a", { class: "btn secondary icon-only" + (prev ? "" : " disabled"), href: prev ? `#/${m.id}/${ei - 1}` : null, title: prev ? "Anterior: " + prev.title : "", "aria-label": "Exercício anterior" }, icon("chevron-left")),
          h("a", { class: "btn secondary icon-only" + (next ? "" : " disabled"), href: next ? `#/${m.id}/${ei + 1}` : null, title: next ? "Próximo: " + next.title : "", "aria-label": "Próximo exercício" }, icon("chevron-right"))),
        moduleActions(m),
      ],
      tabs: tabs.length > 0 && tabs.map((t) => ({ ...t, count: t.items(ex).length, active: t === tab, href: `${base}/${t.id}` })),
    }),
    h("div", { class: "page-body" }, outputAlert(keyOf("script", m.id)), body),
  ];
}

// ---------- recursos (badges no estilo Kiali) ----------
const KIND_ABBR = {
  VirtualService: "VS", DestinationRule: "DR", Gateway: "GW", ServiceEntry: "SE", Sidecar: "SC", WorkloadEntry: "WE",
  EnvoyFilter: "EF", PeerAuthentication: "PA", AuthorizationPolicy: "AP", RequestAuthentication: "RA",
  Telemetry: "TM", WasmPlugin: "WP", HTTPRoute: "HR", GRPCRoute: "GR", ReferenceGrant: "RG",
  Namespace: "NS", ConfigMap: "CM", Secret: "SEC", Deployment: "DP", Service: "S", ServiceAccount: "SA", Job: "JOB",
  Rollout: "RO", AnalysisTemplate: "AT", Certificate: "CRT", ClusterIssuer: "CI", Issuer: "IS", IstioOperator: "IOP",
};

function kindInfo(r) {
  const group = (r.apiVersion || "").split("/")[0];
  let cat = "k8s";
  if (group === "networking.istio.io") cat = r.kind === "EnvoyFilter" ? "ext" : "net";
  else if (group === "security.istio.io") cat = "sec";
  else if (group === "telemetry.istio.io" || group === "extensions.istio.io") cat = "ext";
  else if (group === "gateway.networking.k8s.io") cat = "gwapi";
  else if (group === "argoproj.io") cat = "argo";
  else if (group === "cert-manager.io") cat = "cert";
  let abbr = KIND_ABBR[r.kind] || r.kind.replace(/[a-z]/g, "").slice(0, 3) || r.kind.slice(0, 2).toUpperCase();
  if (cat === "gwapi" && r.kind === "Gateway") abbr = "G";
  return [abbr, cat];
}

function resourceTag(r) {
  const [abbr, cat] = kindInfo(r);
  return h("span", { class: "res", title: `${r.kind} ${r.name}${r.namespace ? " · namespace " + r.namespace : ""}\n${r.apiVersion}` },
    h("span", { class: "kind-badge " + cat }, abbr),
    h("span", { class: "res-name" }, r.name || "—"),
    r.namespace && h("span", { class: "res-ns" }, r.namespace));
}

// ---------- manifests ----------
function paramValues(m, ei, mi, mf) {
  const k = keyOf(m.id, ei, mi);
  state.params[k] ??= Object.fromEntries(mf.params.map((p) => [p.name, p.default]));
  return state.params[k];
}

const yamlEls = new Map(); // chave do manifest -> elemento do editor (atualizado sem re-render)

function manifestCard(m, ex, mi, mf) {
  const ei = state.exIndex;
  const k = keyOf(m.id, ei, mi);
  const st = ((state.status[m.id] || [])[ei] || [])[mi] || (state.loading.has(m.id) ? "loading" : "unknown");
  const values = paramValues(m, ei, mi, mf);
  const body = { module: m.id, exercise: ei, manifest: mi, params: values };
  const isChanged = () => mf.params.some((p) => values[p.name] !== p.default);

  return h("article", { class: "card" },
    h("div", { class: "card-head" },
      icon("file", "muted"),
      h("div", { class: "grow" },
        h("div", { class: "mono path" }, mf.path),
        mf.resources.length > 0 && h("div", { class: "res-list" }, mf.resources.map(resourceTag))),
      stateLabel(st),
      h("div", { class: "card-actions" },
        h("button", { class: "btn secondary", onclick: (e) => busy(e.currentTarget, () => toggleYaml(k, body)) }, icon(state.yaml[k] ? "eye" : "code"), state.yaml[k] ? "Ocultar YAML" : "YAML"),
        h("button", { class: "btn primary", onclick: (e) => busy(e.currentTarget, () => applyManifest(k, body)) }, icon("upload"), "Aplicar"),
        h("button", { class: "btn danger-secondary", onclick: (e) => busy(e.currentTarget, () => deleteManifest(k, body)) }, icon("trash"), "Remover"))),
    mf.note && h("div", { class: "helper" }, icon("info", "status info sm"), mf.note),
    mf.params.length > 0 && h("div", { class: "form" },
      mf.params.map((p) => {
        const changed = values[p.name] !== p.default;
        const id = "p-" + k.replace(/\W/g, "-") + "-" + p.name;
        const input = h("input", {
          id, type: p.type === "number" ? "number" : "text", value: values[p.name],
          class: "input" + (changed ? " changed" : ""),
          oninput: (e) => {
            values[p.name] = e.target.value;
            e.target.classList.toggle("changed", e.target.value !== p.default);
            if (state.yaml[k]) refreshYaml(k, body, isChanged());
          },
        });
        return h("div", { class: "form-group" },
          h("label", { for: id }, p.label),
          h("div", { class: "input-row" }, input,
            changed && h("button", {
              class: "btn plain small", title: `voltar ao valor do arquivo (${p.default})`, "aria-label": "Restaurar valor padrão",
              onclick: () => { values[p.name] = p.default; renderMain(); if (state.yaml[k]) refreshYaml(k, body, isChanged()); },
            }, icon("undo"))),
          h("div", { class: "help" }, p.hint || `padrão: ${p.default}`));
      })),
    state.yaml[k] && yamlEditor(k, mf, isChanged()),
    outputAlert(k),
  );
}

function yamlEditor(k, mf, changed) {
  const code = h("div", { class: "code", html: highlightYaml(state.yaml[k]) });
  const flag = h("span", { class: "label warn sm", hidden: !changed }, "com parâmetros editados");
  yamlEls.set(k, { code, flag });
  return h("div", { class: "editor" },
    h("div", { class: "editor-head" },
      icon("file"), h("span", { class: "mono" }, mf.path), flag, h("span", { class: "grow" }),
      h("button", { class: "btn plain small inverse", onclick: () => copy(state.yaml[k]) }, icon("copy"), "Copiar")),
    code);
}

// destaque de sintaxe simples, linha a linha
function highlightYaml(text) {
  const span = (cls, s) => `<span class="y-${cls}">${esc(s)}</span>`;
  const value = (v) => {
    const cm = v.match(/^(.*?)(\s+#.*)$/);
    const [val, comment] = cm ? [cm[1], cm[2]] : [v, ""];
    let out;
    if (/^(true|false|null|~)$/.test(val)) out = span("kw", val);
    else if (/^-?\d+(\.\d+)?$/.test(val)) out = span("num", val);
    else if (/^[|>][-+]?$/.test(val)) out = span("punct", val);
    else if (val) out = span("str", val);
    else out = "";
    return out + (comment ? span("comment", comment) : "");
  };
  return text.replace(/\n$/, "").split("\n").map((line) => {
    let html;
    let m;
    if (/^\s*#/.test(line)) html = span("comment", line);
    else if (/^---/.test(line)) html = span("sep", line);
    else if ((m = line.match(/^(\s*)(-\s+)?([\w./-]+|"[^"]*"|'[^']*')(:)(\s+|$)(.*)$/))) {
      html = esc(m[1]) + (m[2] ? span("punct", m[2]) : "") + span("key", m[3]) + span("punct", m[4]) + m[5] + value(m[6]);
    } else if ((m = line.match(/^(\s*)(-\s+)(.*)$/))) html = esc(m[1]) + span("punct", m[2]) + value(m[3]);
    else if ((m = line.match(/^(\s*)(.*)$/))) html = esc(m[1]) + (m[2] ? span("str", m[2]) : "");
    return `<div class="line">${html || " "}</div>`;
  }).join("");
}

async function toggleYaml(k, body) {
  if (state.yaml[k]) { delete state.yaml[k]; renderMain(); return; }
  state.yaml[k] = (await api("manifest/render", body)).yaml;
  renderMain();
}

let yamlTimer;
function refreshYaml(k, body, changed) {
  clearTimeout(yamlTimer);
  yamlTimer = setTimeout(async () => {
    try {
      state.yaml[k] = (await api("manifest/render", body)).yaml;
    } catch (e) {
      state.yaml[k] = "# " + e.message;
    }
    const el = yamlEls.get(k);
    if (el && el.code.isConnected) {
      el.code.innerHTML = highlightYaml(state.yaml[k]);
      el.flag.hidden = !changed;
    } else renderMain();
  }, 150);
}

async function applyManifest(k, body) {
  const r = await api("manifest/apply", body);
  state.outputs[k] = { ok: r.ok, text: r.output, title: "Aplicado" };
  if (r.ok) toast("Aplicado. A config leva ~5s para chegar aos Envoys antes de testar.", "success");
  renderMain();
  setTimeout(refreshStatus, 800);
}

async function deleteManifest(k, body) {
  const r = await api("manifest/delete", body);
  state.outputs[k] = { ok: r.ok, text: r.output, title: "Removido" };
  renderMain();
  setTimeout(refreshStatus, 800);
}

function outputAlert(key) {
  const o = state.outputs[key];
  if (!o) return null;
  return h("div", { class: "alert " + (o.ok ? "success" : "danger") },
    h("div", { class: "alert-head" },
      statusIcon(o.ok ? "applied" : "error", true),
      h("strong", { class: "grow" }, o.ok ? (o.title || "Concluído") : "Falhou"),
      h("button", { class: "btn plain small", "aria-label": "Fechar", onclick: () => { delete state.outputs[key]; renderMain(); } }, icon("close"))),
    h("pre", { class: "out" }, o.text.trim() || "(sem saída)"));
}

// ---------- comandos ----------
function actionCard(m, i, a) {
  const k = keyOf("action", m.id, state.exIndex, i);
  return h("article", { class: "card" },
    h("div", { class: "card-head" },
      icon("terminal", "muted"),
      h("h3", { class: "grow" }, a.label),
      h("button", { class: "btn plain", title: "copiar comando", "aria-label": "Copiar comando", onclick: () => copy(a.run.trim()) }, icon("copy")),
      h("button", {
        class: "btn primary", onclick: (e) => busy(e.currentTarget, async () => {
          const r = await api("action", { module: m.id, exercise: state.exIndex, index: i });
          state.outputs[k] = { ok: r.ok, text: r.output };
          renderMain();
          setTimeout(refreshStatus, 500);
        }),
      }, icon("play"), "Executar")),
    h("pre", { class: "cmd" }, a.run.trim()),
    outputAlert(k),
  );
}

// ---------- testes ----------
const PALETTE = ["#0066cc", "#4cb140", "#009596", "#5752d1", "#f4c145", "#ec7a08", "#8bc1f7", "#a2d9d9"];

function barColor(value, i) {
  if (/^2\d\d\b/.test(value)) return "var(--ok)";
  if (/^4\d\d\b/.test(value)) return "var(--warn)";
  if (/^(5\d\d|000)\b/.test(value)) return "var(--bad)";
  return PALETTE[i % PALETTE.length];
}

function testCard(m, i, t) {
  const k = keyOf(m.id, state.exIndex, i);
  const res = state.results[k];
  const passed = res && res.cases.filter((c) => c.pass != null);
  const allPass = passed && passed.length > 0 && passed.every((c) => c.pass);
  return h("article", { class: "card" },
    h("div", { class: "card-head" },
      icon("flask", "muted"),
      h("div", { class: "grow" }, h("h3", {}, t.title), t.summary && h("div", { class: "muted small" }, t.summary)),
      passed && passed.length > 0 && h("span", { class: "label " + (allPass ? "ok" : "bad") }, statusIcon(allPass ? "applied" : "error", true), allPass ? "Passou" : "Divergiu"),
      res && h("span", { class: "muted small" }, `${(res.ms / 1000).toFixed(1)}s`),
      h("button", {
        class: "btn primary", onclick: (e) => busy(e.currentTarget, async () => {
          const start = performance.now();
          const r = await api("test", { module: m.id, exercise: state.exIndex, index: i });
          r.ms = performance.now() - start;
          state.results[k] = r;
          renderMain();
        }),
      }, icon(res ? "sync" : "play"), res ? "Rodar de novo" : "Rodar teste")),
    res && h("div", { class: "cases" }, res.cases.map((c) => caseResult(c, t.chart))),
  );
}

function caseResult(c, chart) {
  let body;
  if (c.error) {
    body = h("pre", { class: "out bad" }, c.error);
  } else if (chart || c.total > 1) {
    body = h("div", { class: "bars" }, c.counts.flatMap((x, i) => {
      const pct = (100 * x.n) / c.total;
      return [
        h("span", { class: "name mono", title: x.value }, h("span", { class: "swatch", style: `background:${barColor(x.value, i)}` }), x.value),
        h("span", { class: "track" }, h("span", { class: "fill", style: `width:${pct}%;background:${barColor(x.value, i)}` })),
        h("span", { class: "pct" }, h("strong", {}, x.n), ` · ${pct.toFixed(0)}%`),
      ];
    }));
  } else {
    body = h("div", { class: "values" }, c.counts.map((x) => h("span", { class: "value mono" }, x.value)));
  }
  return h("div", { class: "case" },
    h("div", { class: "case-head" },
      c.pass != null && statusIcon(c.pass ? "applied" : "error", true),
      h("span", { class: "case-label" }, c.label),
      h("span", { class: "label sm" }, c.where),
      c.total > 1 && h("span", { class: "label sm" }, `${c.total} amostras`),
      c.pass != null && h("span", { class: "muted small", title: "regex esperada em todas as amostras" }, (c.pass ? "como esperado: " : "esperado: "), h("code", {}, c.expect))),
    body,
    c.script && h("details", {}, h("summary", {}, "script executado"), h("pre", { class: "cmd" }, c.script.trim())),
  );
}

async function runScript(btn, m, which) {
  await busy(btn, async () => {
    toast(`Rodando ${m.id}/${which === "setup" ? m.setup : m.reset}… pode levar alguns minutos.`);
    const r = await api("script", { module: m.id, script: which });
    state.outputs[keyOf("script", m.id)] = { ok: r.ok, text: r.output, title: which === "setup" ? "Setup concluído" : "Reset concluído" };
    for (const k of Object.keys(state.params)) if (k.startsWith(m.id + "/")) delete state.params[k];
    renderMain();
    await refreshStatus(m.id);
  });
}

// ---------- status do cluster e dos manifests ----------
async function refreshStatus(id = state.moduleId) {
  if (typeof id !== "string") id = state.moduleId;
  state.loading.add(id);
  render();
  try {
    state.status[id] = (await api("status?module=" + encodeURIComponent(id))).exercises;
    state.statusAt[id] = new Date();
  } catch (e) {
    toast("Status: " + e.message, "danger");
  } finally {
    state.loading.delete(id);
  }
  render();
}

// na visão geral: verifica os módulos um por vez (cada um roda vários kubectl)
let loadingAll = false;
async function loadAllStatus(force) {
  if (loadingAll) return;
  loadingAll = true;
  try {
    for (const m of state.catalog.modules) {
      if (force || !state.status[m.id]) await refreshStatus(m.id);
    }
  } finally {
    loadingAll = false;
  }
}

async function refreshCluster() {
  try {
    state.cluster = await api("cluster");
  } catch {
    state.cluster = { context: "?", reachable: false, error: "console sem resposta" };
  }
  renderMasthead();
  if (state.view === "overview" && !openMenu) renderMain();
}

function renderMasthead() {
  const el = $("#cluster");
  if (openMenu && el.contains(openMenu.wrap)) return; // não fecha o popover aberto
  const c = state.cluster;
  if (!c) { el.replaceChildren(icon("spin")); return; }
  const items = [h("span", { class: "mh-item", title: "contexto do kubeconfig" }, icon("server"), c.context)];
  if (!c.reachable) {
    items.push(h("span", { class: "mh-item bad", title: c.error || "" }, statusIcon("error", true), "cluster inacessível"));
  } else {
    const bad = c.components.filter((x) => x.ready < x.desired);
    items.push(h("span", { class: "mh-item mh-version" }, "Istio " + (c.istio || "?"), c.ambient && h("span", { class: "mh-tag" }, "ambient")));
    items.push(dropdown(
      [statusIcon(bad.length ? "partial" : "applied", true), h("span", { class: "mh-text" }, bad.length ? `${bad.length} não prontos` : "istio-system")],
      h("div", { class: "popover" },
        h("div", { class: "popover-title" }, "Componentes do istio-system"),
        h("ul", { class: "components" }, c.components.map((x) =>
          h("li", {}, statusIcon(x.ready >= x.desired ? "applied" : "partial", true), h("span", { class: "grow mono" }, x.name), h("span", { class: "muted small" }, `${x.kind === "DaemonSet" ? "ds" : "deploy"} ${x.ready}/${x.desired}`))))),
      { cls: "btn plain inverse mh-status", title: "estado do plano de controle" }));
  }
  el.replaceChildren(...items);
}

async function loadDashboards() {
  try {
    state.dashboards = (await api("dashboards")).dashboards;
  } catch { state.dashboards = []; }
  renderNav();
}

async function openDashboard(d) {
  const w = window.open("about:blank", "_blank");
  try {
    const { url } = await api("dashboards/" + d.name, {});
    if (w) w.location = url; else window.open(url, "_blank");
  } catch (err) {
    if (w) w.close();
    throw err;
  }
}

// ---------- log de comandos ----------
async function pollLog() {
  try {
    const { entries } = await api("log?after=" + state.logAfter);
    if (entries.length) {
      state.log.push(...entries);
      state.log = state.log.slice(-300);
      state.logAfter = entries[entries.length - 1].id;
      renderLog();
    }
  } catch { /* console reiniciando */ }
}

function renderLog() {
  const fails = state.log.filter((e) => !e.ok).length;
  $("#log-count").textContent = state.log.length;
  $("#log-count").classList.toggle("bad", fails > 0 && state.log[state.log.length - 1]?.ok === false);
  if ($("#log").hidden) return;
  $("#log-filter").replaceChildren(...[["all", `Todos (${state.log.length})`], ["fail", `Falhas (${fails})`]].map(([id, text]) =>
    h("button", { class: "toggle" + (state.logFilter === id ? " current" : ""), "aria-pressed": String(state.logFilter === id), onclick: () => { state.logFilter = id; renderLog(); } }, text)));
  const list = state.log.filter((e) => state.logFilter === "all" || !e.ok).reverse();
  $("#log-list").replaceChildren(...(list.length ? list.map((e) =>
    h("li", { class: "log-entry" + (e.ok ? "" : " failed") },
      h("div", { class: "log-meta" },
        statusIcon(e.ok ? "applied" : "error", true),
        h("span", { class: "label sm" }, e.kind),
        h("span", { class: "grow" }, time(new Date(e.time))),
        h("span", {}, `${e.ms} ms`),
        h("button", { class: "btn plain small", title: "copiar comando", "aria-label": "Copiar comando", onclick: () => copy(e.command) }, icon("copy"))),
      h("pre", { class: "cmd" }, e.command),
      e.output && h("details", {}, h("summary", {}, "saída"), h("pre", { class: "out" }, e.output))))
    : [h("li", { class: "empty" }, "Nenhum comando ainda.")]));
}

function toggleLog(open) {
  const log = $("#log");
  log.hidden = !open;
  $("#log-toggle").setAttribute("aria-expanded", String(open));
  if (open) renderLog();
}

// ---------- tema ----------
function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  $("#theme-toggle").replaceChildren(icon(dark ? "sun" : "moon"));
}

function toggleTheme() {
  const cur = document.documentElement.dataset.theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  const next = cur === "dark" ? "light" : "dark";
  try { localStorage.setItem("istio-lab-theme", next); } catch { /* sem storage */ }
  applyTheme(next);
}

// ---------- início ----------
async function init() {
  for (const el of document.querySelectorAll("[data-icon]")) el.replaceChildren(icon(el.dataset.icon));
  let theme = null;
  try { theme = localStorage.getItem("istio-lab-theme"); } catch { /* sem storage */ }
  applyTheme(theme);
  $("#theme-toggle").addEventListener("click", toggleTheme);
  $("#nav-toggle").addEventListener("click", () => {
    const mobile = matchMedia("(max-width: 900px)").matches;
    const cls = mobile ? "nav-open" : "nav-collapsed";
    document.body.classList.toggle(cls);
    $("#nav-toggle").setAttribute("aria-expanded", String(mobile ? document.body.classList.contains(cls) : !document.body.classList.contains(cls)));
  });
  $("#log-toggle").addEventListener("click", () => toggleLog($("#log").hidden));
  $("#log-close").addEventListener("click", () => toggleLog(false));
  renderMasthead();
  try {
    state.catalog = await api("catalog");
  } catch (e) {
    $("#main").replaceChildren(h("div", { class: "page-body" }, h("div", { class: "alert danger" }, h("div", { class: "alert-head" }, statusIcon("error", true), h("strong", {}, "Não foi possível carregar o catálogo")), h("div", {}, e.message))));
    return;
  }
  parseHash();
  render();
  refreshCluster();
  loadDashboards();
  if (state.view === "overview") loadAllStatus(false);
  else refreshStatus();
  pollLog();
  setInterval(refreshCluster, 15000);
  setInterval(pollLog, 3000);
}

init();
