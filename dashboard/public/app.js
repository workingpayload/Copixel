"use strict";
(() => {
  const $ = (s) => document.querySelector(s);
  const SVG = "http://www.w3.org/2000/svg";
  let report = null;
  let chartMode = "usd";
  const expanded = new Set();

  const fmtInt = (n) => Math.round(n || 0).toLocaleString();
  const fmtTok = (n) => {
    const a = Math.abs(n || 0);
    const s = a >= 1e6 ? (a / 1e6).toFixed(2) + "M" : a >= 1e4 ? (a / 1e3).toFixed(1) + "k" : fmtInt(a);
    return (n < 0 ? "−" : "") + s;
  };
  const fmtUsd = (n) => {
    const a = Math.abs(n || 0);
    const s = a === 0 ? "$0.00" : a < 0.01 ? "$" + a.toFixed(4) : "$" + a.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (n < 0 ? "−" : "") + s;
  };
  const fmtPct = (n) => (n || 0).toFixed(1) + "%";
  const ago = (iso) => {
    if (!iso) return "–";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    if (s < 86400 * 30) return Math.floor(s / 86400) + "d ago";
    return new Date(iso).toLocaleDateString();
  };

  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "title") n.title = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids.flat()) if (c != null) n.append(c instanceof Node ? c : String(c));
    return n;
  }
  const td = (v, cls) => el("td", { class: cls }, v);
  const signCls = (n) => "num " + (n > 0 ? "pos" : n < 0 ? "neg" : "dim");
  const setText = (sel, v) => { $(sel).textContent = v; };
  const fill = (tbody, rows, cols) => {
    tbody.replaceChildren(...(rows.length ? rows : [el("tr", {}, el("td", { class: "empty", colspan: cols }, "No data yet"))]));
  };

  function renderKpis(r) {
    const t = r.totals;
    setText("#k-usd", fmtUsd(t.usdNet));
    setText("#k-usd-sub", `${fmtUsd(t.usdFirst)} first send + ${fmtUsd(t.usdReread)} cache re-reads`);
    setText("#k-tokens", fmtTok(t.netSavedTokens));
    setText("#k-tokens-sub", `${fmtTok(t.grossSavedTokens)} gross − ${fmtTok(t.getTextTokens)} via get_text`);
    setText("#k-imaged", fmtInt(t.imaged));
    setText("#k-imaged-sub", `${fmtInt(t.pages)} pages · ${fmtInt(t.skipped)} skipped · ${fmtInt(t.errors)} errors`);
    setText("#k-comp", fmtPct(t.compressionPct));
    setText("#k-comp-sub", `${fmtTok(t.textTokens)} text → ${fmtTok(t.imageTokens)} image tokens`);
    setText("#k-sessions", `${fmtInt(t.sessionsTracked)} / ${fmtInt(t.sessionsAll)}`);
    setText("#k-sessions-sub", "with copixel / all Copilot sessions");
    setText("#k-spend", fmtUsd(t.allSpendUsd));
    setText("#k-spend-sub", t.trackedSpendUsd > 0
      ? `copixel saved ${fmtPct(t.pctOfWouldBeSpend)} in tracked sessions`
      : "all sessions, from the Copilot session store");
  }

  function renderChart(r) {
    const box = $("#chart");
    const days = r.daily;
    const key = chartMode === "usd" ? "usd" : "savedTokens";
    const vals = days.map((d) => d[key]);
    const max = Math.max(...vals.map(Math.abs), chartMode === "usd" ? 0.01 : 100);
    const W = 1000, H = 220, L = 56, B = 22, T = 8;
    const ph = H - B - T, bw = (W - L) / days.length;
    const svg = document.createElementNS(SVG, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("preserveAspectRatio", "none");
    const mk = (tag, a, text) => {
      const n = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(a)) n.setAttribute(k, v);
      if (text != null) n.textContent = text;
      return n;
    };
    for (const f of [0, 0.5, 1]) {
      const y = T + ph * (1 - f);
      svg.append(mk("line", { x1: L, x2: W, y1: y, y2: y, class: "axis" }));
      svg.append(mk("text", { x: L - 6, y: y + 3, "text-anchor": "end" }, chartMode === "usd" ? fmtUsd(max * f) : fmtTok(max * f)));
    }
    days.forEach((d, i) => {
      const v = d[key];
      const h = (Math.abs(v) / max) * ph;
      const rect = mk("rect", { x: L + i * bw + 2, y: T + ph - h, width: Math.max(1, bw - 4), height: Math.max(v ? 1 : 0, h), class: "bar" + (v < 0 ? " neg" : "") });
      rect.append(mk("title", {}, `${d.date}: ${fmtUsd(d.usd)} · ${fmtTok(d.savedTokens)} tokens · ${d.imaged} imaged`));
      svg.append(rect);
      if (i % 5 === 0 || i === days.length - 1) svg.append(mk("text", { x: L + i * bw + bw / 2, y: H - 6, "text-anchor": "middle" }, d.date.slice(5)));
    });
    box.replaceChildren(svg);
  }

  function sessionDetail(s) {
    const pairs = [
      ["Session id", s.id], ["Directory", s.cwd || "–"],
      ["Branch", s.branch || "–"], ["Created", s.createdAt ? new Date(s.createdAt).toLocaleString() : "–"],
    ];
    if (s.copixel) pairs.push(
      ["Text tokens imaged", fmtInt(s.copixel.textTokens)], ["get_text calls", fmtInt(s.copixel.getTextCalls)],
      ["$ first send", fmtUsd(s.copixel.usdFirst)], ["Skipped / errors", `${s.copixel.skipped} / ${s.copixel.errors}`],
    );
    if (s.usage) pairs.push(
      ["Input tokens", fmtInt(s.usage.inputTokens)], ["Output tokens", fmtInt(s.usage.outputTokens)],
      ["Cache read tokens", fmtInt(s.usage.cacheReadTokens)], ["Cache write tokens", fmtInt(s.usage.cacheWriteTokens)],
      ["AI credits", s.usage.credits.toFixed(2)], ["Resume", `copilot --resume ${s.id}`],
    );
    return el("dl", {}, pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v)]));
  }

  function renderSessions(r) {
    const only = $("#only-copixel").checked;
    const q = $("#filter").value.trim().toLowerCase();
    const rows = [];
    for (const s of r.sessions) {
      if (only && !s.copixel) continue;
      if (q && ![s.name, s.repository, s.id, s.cwd, ...(s.models || [])].some((x) => x && x.toLowerCase().includes(q))) continue;
      const c = s.copixel;
      const toggle = () => { expanded.has(s.id) ? expanded.delete(s.id) : expanded.add(s.id); renderSessions(report); };
      rows.push(el("tr", { class: "clickable", onclick: toggle },
        el("td", { class: "name", title: s.name || s.id }, s.name || el("span", { class: "dim" }, "(untitled)"), el("small", {}, s.id.slice(0, 8))),
        td(s.repository || (s.cwd ? s.cwd.split("/").pop() : "–")),
        el("td", { title: s.lastActive || "" }, ago(s.lastActive)),
        td((s.models || []).join(", ") || "–", "dim"),
        td(c ? fmtInt(c.imaged) : "–", "num"),
        td(c ? fmtTok(c.savedTokens) : "–", c ? signCls(c.savedTokens) : "num dim"),
        td(c ? fmtUsd(c.usdNet) : "–", c ? signCls(c.usdNet) : "num dim"),
        td(s.usage ? fmtInt(s.usage.calls) : "–", "num"),
        td(s.usage ? fmtUsd(s.usage.spendUsd) : "–", "num"),
      ));
      if (expanded.has(s.id)) rows.push(el("tr", { class: "detail" }, el("td", { colspan: 9 }, sessionDetail(s))));
    }
    fill($("#sessions tbody"), rows, 9);
  }

  function renderGroups(sel, groups) {
    fill($(sel + " tbody"), groups.map((g) => el("tr", {},
      td(g.key), td(fmtInt(g.imaged), "num"), td(fmtTok(g.savedTokens), signCls(g.savedTokens)), td(fmtUsd(g.usdNet), signCls(g.usdNet)),
    )), 4);
  }

  function showImage(name) {
    const box = $("#preview");
    box.querySelector("img").src = "/api/image/" + encodeURIComponent(name);
    box.classList.remove("hidden");
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  function renderRecent(r) {
    fill($("#recent tbody"), r.recent.map((e) => el("tr", { title: e.reason || "" },
      el("td", { title: e.ts }, new Date(e.ts).toLocaleString()),
      el("td", {}, el("span", { class: "tag " + e.type }, e.type + (e.id ? " " + e.id : ""))),
      td(e.tool || "–"), td(e.model || "–", "dim"),
      td(e.chars ? fmtInt(e.chars) : "–", "num"), td(e.pages || "–", "num"),
      td(e.textTokens ? fmtInt(e.textTokens) : "–", "num"), td(e.imageTokens ? fmtInt(e.imageTokens) : "–", "num"),
      td(e.savedTokens ? fmtTok(e.savedTokens) : "–", signCls(e.savedTokens)),
      td(e.usd ? fmtUsd(e.usd) : "–", signCls(e.usd)),
      el("td", {}, e.image ? el("button", { class: "link", onclick: () => showImage(e.image) }, "view") : ""),
    )), 11);
  }

  function renderPricing(r) {
    const a = $("#assumptions");
    a.replaceChildren(
      el("div", {}, "Dollar savings are ", el("b", {}, "estimates"), ". Each imaged result is priced at the model's cache-write rate once (input rate if there is none), plus the cache-read rate for every later model call in the same session. ",
        "Tokens pulled back with ", el("code", {}, "copixel_get_text"), " are priced the same way and subtracted. Context compaction is ignored, so the re-read part is an upper bound."),
      el("div", {}, `Rates and spend come from Copilot's local session store (AI credits × $${r.usdPerCredit} — set COPIXEL_USD_PER_CREDIT to change). Text tokens are estimated at chars/4.`),
      r.unpricedModels.length ? el("div", {}, `No rates found for ${r.unpricedModels.join(", ")}; a fallback of $${r.fallbackUsdPerMTok}/M input tokens is used.`) : null,
      el("div", {}, `${fmtInt(r.sources?.events)} events in the copixel log · updated ${new Date(r.generatedAt).toLocaleTimeString()}`),
    );
    fill($("#pricing tbody"), r.pricing.map((p) => el("tr", {},
      el("td", {}, p.model, p.usedByCopixel ? el("span", { class: "tag imaged" }, " used") : ""),
      td("$" + p.inputUsdPerM.toFixed(2), "num"), td("$" + p.cacheWriteUsdPerM.toFixed(2), "num"),
      td("$" + p.cacheReadUsdPerM.toFixed(2), "num"), td("$" + p.outputUsdPerM.toFixed(2), "num"),
    )), 5);
  }

  function renderBanner(r) {
    const b = $("#banner");
    const msgs = [];
    if (!r.sources?.usageAvailable) msgs.push(`Copilot session store not readable (${r.sources?.usageError || "unknown"}). Sessions and spend will be incomplete; $ uses fallback rates.`);
    if (!r.sources?.events) msgs.push("No copixel events logged yet. Make sure the copixel extension (with event logging) is installed and run a command with large output in Copilot CLI.");
    b.textContent = msgs.join(" ");
    b.classList.toggle("hidden", !msgs.length);
  }

  function render() {
    if (!report) return;
    renderBanner(report);
    renderKpis(report);
    renderChart(report);
    renderSessions(report);
    renderGroups("#by-model", report.byModel);
    renderGroups("#by-tool", report.byTool);
    renderRecent(report);
    renderPricing(report);
  }

  async function refresh() {
    try {
      const res = await fetch("/api/report.json", { cache: "no-store" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      report = await res.json();
      render();
      setText("#status", "live · " + new Date().toLocaleTimeString());
    } catch (err) {
      setText("#status", "offline: " + err.message);
    }
  }

  $("#only-copixel").addEventListener("change", () => renderSessions(report));
  $("#filter").addEventListener("input", () => renderSessions(report));
  for (const b of document.querySelectorAll("#chart-mode button")) {
    b.addEventListener("click", () => {
      chartMode = b.dataset.mode;
      document.querySelectorAll("#chart-mode button").forEach((x) => x.classList.toggle("on", x === b));
      renderChart(report);
    });
  }
  refresh();
  setInterval(refresh, 5000);
})();
