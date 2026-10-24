"use strict";

// ---------- estado ----------
const state = {
  catalog: null,
  moduleId: null,
  exIndex: 0,
  status: {},        // moduleId -> [[state por manifest]]
  params: {},        // "mod/ex/mf" -> {nome: valor}
  outputs: {},       // chave -> {ok, text}
  results: {},       // "mod/ex/test" -> resposta do teste
  yaml: {},          // "mod/ex/mf" -> yaml renderizado (quando aberto)
  logAfter: 0,
  log: [],
};

const STATE_LABEL = {
  applied: ["aplicado", "ok"],
  modified: ["existe com outra config", "warn"],
  partial: ["parcial", "warn"],
  absent: ["não aplicado", ""],
  error: ["erro / CRD ausente", "bad"],
};

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
  for (const c of children.flat()) {
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

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 4500);
}

// executa uma operação com o botão desabilitado enquanto roda
async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add("running");
  try { return await fn(); }
  catch (e) { toast("Erro: " + e.message); }
  finally { btn.disabled = false; btn.classList.remove("running"); pollLog(); }
}

const mod = () => state.catalog.modules.find((m) => m.id === state.moduleId);
const keyOf = (...p) => p.join("/");

// ---------- navegação ----------
function parseHash() {
  const [, m, e] = location.hash.match(/^#\/([^/]+)\/?(\d+)?/) || [];
  const mods = state.catalog.modules;
  state.moduleId = mods.some((x) => x.id === m) ? m : mods[0].id;
  state.exIndex = Math.min(Number(e || 0), mod().exercises.length - 1);
}

function go(moduleId, ex) {
  location.hash = `#/${moduleId}/${ex}`;
}

window.addEventListener("hashchange", () => {
  const prev = state.moduleId;
  parseHash();
  if (prev !== state.moduleId) refreshStatus();
  render();
});

// ---------- render ----------
function render() {
  renderSidebar();
  renderMain();
}

function exerciseDot(moduleId, ei) {
  const st = (state.status[moduleId] || [])[ei];
  if (!st || st.length === 0) return "dot";
  if (st.includes("error")) return "dot error";
  if (st.every((s) => s === "applied")) return "dot applied";
  if (st.some((s) => s !== "absent")) return "dot partial";
  return "dot";
}

function renderSidebar() {
  const sb = $("#sidebar");
  sb.replaceChildren(...state.catalog.modules.map((m) =>
    h("div", { class: "mod" },
      h("button", { class: "mod-title", onclick: () => go(m.id, 0) },
        m.id.split("-")[0] + " · " + m.title, h("span", { class: "muted" }, m.id)),
      m.exercises.map((ex, i) =>
        h("a", {
          class: "ex-link" + (m.id === state.moduleId && i === state.exIndex ? " active" : ""),
          href: `#/${m.id}/${i}`,
        }, h("span", { class: exerciseDot(m.id, i), title: "estado dos manifests" }), ex.title))
    )
  ));
}

function renderMain() {
  const m = mod();
  const ex = m.exercises[state.exIndex];
  const main = $("#main");
  main.replaceChildren(
    h("div", { class: "module-head" },
      h("div", {},
        h("div", { class: "crumb" }, `${m.id} · ${m.title}`),
        h("h1", {}, ex.title)),
      h("div", { class: "buttons" },
        m.setup && h("button", { class: "btn", title: `roda ${m.id}/${m.setup}`, onclick: (e) => runScript(e.target, m, "setup") }, "Setup do módulo"),
        m.reset && h("button", { class: "btn danger", title: `roda ${m.id}/${m.reset}`, onclick: (e) => runScript(e.target, m, "reset") }, "Reset do módulo"),
        h("button", { class: "btn ghost", title: "recarrega o estado do cluster", onclick: (e) => busy(e.target, refreshStatus) }, "↻"))),
    h("div", { class: "summary", html: md(ex.summary) }),
    outputBlock(keyOf("script", m.id)),
    ex.manifests.length > 0 && h("div", { class: "section-title" }, "Manifests"),
    ex.manifests.map((mf, i) => manifestCard(m, ex, i, mf)),
    ex.actions.length > 0 && h("div", { class: "section-title" }, "Comandos"),
    ex.actions.map((a, i) => actionCard(m, i, a)),
    ex.tests.length > 0 && h("div", { class: "section-title" }, "Testes"),
    ex.tests.map((t, i) => testCard(m, i, t)),
  );
}

function outputBlock(key) {
  const o = state.outputs[key];
  if (!o) return null;
  return h("div", {},
    h("div", { class: "output-head" },
      h("span", { class: o.ok ? "chip ok" : "chip bad" }, o.ok ? "ok" : "falhou"),
      h("button", { class: "btn ghost small", onclick: () => { delete state.outputs[key]; renderMain(); } }, "limpar")),
    h("pre", { class: o.ok ? "" : "bad" }, o.text.trim() || "(sem saída)"));
}

function paramValues(m, ei, mi, mf) {
  const k = keyOf(m.id, ei, mi);
  state.params[k] ??= Object.fromEntries(mf.params.map((p) => [p.name, p.default]));
  return state.params[k];
}

function manifestCard(m, ex, mi, mf) {
  const ei = state.exIndex;
  const k = keyOf(m.id, ei, mi);
  const st = ((state.status[m.id] || [])[ei] || [])[mi];
  const [label, cls] = STATE_LABEL[st] || ["…", ""];
  const values = paramValues(m, ei, mi, mf);
  const body = { module: m.id, exercise: ei, manifest: mi, params: values };

  return h("div", { class: "card" },
    h("div", { class: "card-head" },
      h("div", { class: "grow" },
        h("code", {}, mf.path),
        mf.note && h("div", { class: "note" }, mf.note)),
      h("span", { class: "chip " + cls }, label),
      h("div", { class: "card-actions" },
        h("button", { class: "btn ghost", onclick: (e) => busy(e.target, () => toggleYaml(k, body)) }, state.yaml[k] ? "Ocultar YAML" : "Ver YAML"),
        h("button", { class: "btn primary", onclick: (e) => busy(e.target, () => applyManifest(k, body)) }, "Aplicar"),
        h("button", { class: "btn danger", onclick: (e) => busy(e.target, () => deleteManifest(k, body)) }, "Remover"))),
    mf.params.length > 0 && h("div", { class: "params" },
      mf.params.map((p) =>
        h("label", { class: "param" },
          p.label,
          h("input", {
            type: p.type === "number" ? "number" : "text",
            value: values[p.name],
            class: values[p.name] !== p.default ? "changed" : "",
            oninput: (e) => {
              values[p.name] = e.target.value;
              e.target.classList.toggle("changed", e.target.value !== p.default);
              if (state.yaml[k]) refreshYaml(k, body);
            },
          }),
          p.hint && h("span", { class: "hint" }, p.hint)))),
    state.yaml[k] && h("pre", {}, state.yaml[k]),
    outputBlock(k),
  );
}

async function toggleYaml(k, body) {
  if (state.yaml[k]) { delete state.yaml[k]; renderMain(); return; }
  await refreshYaml(k, body);
}

let yamlTimer;
async function refreshYaml(k, body) {
  clearTimeout(yamlTimer);
  yamlTimer = setTimeout(async () => {
    try {
      state.yaml[k] = (await api("manifest/render", body)).yaml;
    } catch (e) {
      state.yaml[k] = "# " + e.message;
    }
    renderMain();
  }, 150);
}

async function applyManifest(k, body) {
  const r = await api("manifest/apply", body);
  state.outputs[k] = { ok: r.ok, text: r.output };
  if (r.ok) toast("Aplicado. A config leva ~5s para chegar aos Envoys antes de testar.");
  renderMain();
  setTimeout(refreshStatus, 800);
}

async function deleteManifest(k, body) {
  const r = await api("manifest/delete", body);
  state.outputs[k] = { ok: r.ok, text: r.output };
  renderMain();
  setTimeout(refreshStatus, 800);
}

function actionCard(m, i, a) {
  const k = keyOf("action", m.id, state.exIndex, i);
  return h("div", { class: "card" },
    h("div", { class: "card-head" },
      h("div", { class: "grow" }, h("strong", {}, a.label)),
      h("button", {
        class: "btn", onclick: (e) => busy(e.target, async () => {
          const r = await api("action", { module: m.id, exercise: state.exIndex, index: i });
          state.outputs[k] = { ok: r.ok, text: r.output };
          renderMain();
          setTimeout(refreshStatus, 500);
        }),
      }, "Executar")),
    h("details", {}, h("summary", {}, "comando"), h("pre", {}, a.run.trim())),
    outputBlock(k),
  );
}

function testCard(m, i, t) {
  const k = keyOf(m.id, state.exIndex, i);
  const res = state.results[k];
  return h("div", { class: "card" },
    h("div", { class: "card-head" },
      h("div", { class: "grow" }, h("strong", {}, t.title), t.summary && h("div", { class: "note" }, t.summary)),
      res && h("span", { class: "muted" }, `${(res.ms / 1000).toFixed(1)}s`),
      h("button", {
        class: "btn primary", onclick: (e) => busy(e.target, async () => {
          const start = performance.now();
          const r = await api("test", { module: m.id, exercise: state.exIndex, index: i });
          r.ms = performance.now() - start;
          state.results[k] = r;
          renderMain();
        }),
      }, res ? "Rodar de novo" : "Rodar teste")),
    res && h("div", { class: "cases" }, res.cases.map((c) => caseResult(c, t.chart))),
  );
}

function caseResult(c, chart) {
  const passChip = c.pass == null ? null
    : h("span", { class: c.pass ? "chip ok" : "chip bad", title: "esperado: " + c.expect }, c.pass ? "✓ como esperado" : "✗ esperado " + c.expect);
  let body;
  if (c.error) {
    body = h("pre", { class: "bad" }, c.error);
  } else if (chart || c.total > 1) {
    body = h("div", { class: "bars" }, c.counts.flatMap((x) => {
      const pct = (100 * x.n) / c.total;
      return [
        h("span", { class: "name", title: x.value }, x.value),
        h("span", { class: "track" }, h("span", { class: "fill", style: `width:${pct}%` })),
        h("span", { class: "pct" }, `${x.n} · ${pct.toFixed(0)}%`),
      ];
    }));
  } else {
    body = h("div", { class: "values" }, c.counts.map((x) => h("span", { class: "value" }, x.value)));
  }
  return h("div", { class: "case" },
    h("div", { class: "case-head" },
      h("span", { class: "label" }, c.label),
      h("span", { class: "chip" }, c.where),
      c.total > 1 && h("span", { class: "chip" }, `${c.total} amostras`),
      passChip),
    body,
    c.script && h("details", {}, h("summary", {}, "script executado"), h("pre", {}, c.script.trim())),
  );
}

async function runScript(btn, m, which) {
  await busy(btn, async () => {
    toast(`Rodando ${m.id}/${which === "setup" ? m.setup : m.reset}… pode levar alguns minutos.`);
    const r = await api("script", { module: m.id, script: which });
    state.outputs[keyOf("script", m.id)] = { ok: r.ok, text: r.output };
    for (const k of Object.keys(state.params)) if (k.startsWith(m.id + "/")) delete state.params[k];
    renderMain();
    await refreshStatus();
  });
}

// ---------- status do cluster e dos manifests ----------
async function refreshStatus() {
  const id = state.moduleId;
  try {
    state.status[id] = (await api("status?module=" + encodeURIComponent(id))).exercises;
  } catch (e) {
    toast("Status: " + e.message);
  }
  render();
}

async function refreshCluster() {
  const el = $("#cluster");
  try {
    const c = await api("cluster");
    const chips = [h("span", { class: "chip info" }, "contexto " + c.context)];
    if (!c.reachable) {
      chips.push(h("span", { class: "chip bad", title: c.error || "" }, "cluster inacessível"));
    } else {
      chips.push(h("span", { class: "chip" }, "Istio " + (c.istio || "?")));
      if (c.ambient) chips.push(h("span", { class: "chip" }, "ambient"));
      const bad = c.components.filter((x) => x.ready < x.desired);
      chips.push(bad.length === 0
        ? h("span", { class: "chip ok", title: c.components.map((x) => `${x.name} ${x.ready}/${x.desired}`).join("\n") }, `istio-system ok (${c.components.length})`)
        : h("span", { class: "chip warn", title: bad.map((x) => `${x.name} ${x.ready}/${x.desired}`).join("\n") }, `${bad.length} componente(s) não prontos`));
    }
    el.replaceChildren(...chips);
  } catch (e) {
    el.replaceChildren(h("span", { class: "chip bad" }, "console sem resposta"));
  }
}

async function renderDashboards() {
  const { dashboards } = await api("dashboards");
  $("#dashboards").replaceChildren(...dashboards.map((d) =>
    h("button", {
      class: "btn ghost small", title: `port-forward para localhost:${d.port}`,
      onclick: (e) => busy(e.target, async () => {
        const w = window.open("about:blank", "_blank");
        try {
          const { url } = await api("dashboards/" + d.name, {});
          if (w) w.location = url; else window.open(url, "_blank");
        } catch (err) {
          if (w) w.close();
          throw err;
        }
      }),
    }, d.label + " ↗")));
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
  $("#log-count").textContent = state.log.length;
  if ($("#log").hidden) return;
  $("#log-list").replaceChildren(...state.log.slice().reverse().map((e) =>
    h("li", { class: "log-entry" },
      h("div", { class: "log-meta" },
        h("span", { class: e.ok ? "chip ok" : "chip bad" }, e.ok ? "ok" : "falhou"),
        h("span", { class: "chip" }, e.kind),
        new Date(e.time).toLocaleTimeString(), " · ", `${e.ms} ms`),
      h("pre", {}, e.command),
      e.output && h("details", {}, h("summary", {}, "saída"), h("pre", {}, e.output)))));
}

function toggleLog(open) {
  const log = $("#log");
  log.hidden = !open;
  $("#log-toggle").setAttribute("aria-expanded", String(open));
  if (open) renderLog();
}

// ---------- início ----------
async function init() {
  $("#log-toggle").addEventListener("click", () => toggleLog($("#log").hidden));
  $("#log-close").addEventListener("click", () => toggleLog(false));
  try {
    state.catalog = await api("catalog");
  } catch (e) {
    $("#main").replaceChildren(h("div", { class: "empty" }, "Não foi possível carregar o catálogo: " + e.message));
    return;
  }
  parseHash();
  render();
  refreshCluster();
  renderDashboards();
  refreshStatus();
  pollLog();
  setInterval(refreshCluster, 15000);
  setInterval(pollLog, 3000);
}

init();
