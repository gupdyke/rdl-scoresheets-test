// RDL Scoresheets page: pick a division, week and (optionally) your team; download
// each match as one PDF (Front + Back); sign up for the weekly
// emails. Two ways to run:
//   local (rdl/web.py):        /api/catalog, /combined.pdf, /api/signup on the same server
//   public (build_public.py):  window.SCORESHEETS = {public, version, signupURL, turnstileSiteKey};
//                              data/catalog.json and pdf/... files on GitHub Pages; sign-ups go to
//                              the Cloudflare worker with a Turnstile check.
const CFG = window.SCORESHEETS || {};
const $ = (id) => document.getElementById(id);
const LETTERS = "ABCDEFGH".split("");
let catalog = null;
let turnstileId = null;

const el = (tag, attrs = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), attrs);
  e.append(...kids.filter((k) => k != null && k !== ""));
  return e;
};
const store = {   // remembered division and team (this browser only)
  get(k) { try { return localStorage.getItem(`rdl-scoresheets-${k}`); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`rdl-scoresheets-${k}`, v); } catch { /* private mode */ } },
};
const team = (code, name) => `${code} - ${name}`;
const label = (l) => l.replace("/ ", " - ");   // "F7/ Nein Mark" -> "F7 - Nein Mark"
const div = () => $("division").value;
const week = () => catalog.weeks.find((w) => String(w.number) === $("week").value);

// One match's 2-page PDF (Front + Back).
function matchURL(m, download) {
  if (CFG.public) return `${m.pdf}?v=${CFG.version}`;
  const q = new URLSearchParams({ week: $("week").value, div: div(), home: m.home_code });
  return `/combined.pdf?${q}${download ? "&download" : ""}`;
}
const matchFile = (m) => (m.pdf ? m.pdf.split("/").pop() : null);

// On a phone, a PDF link opens a viewer with no way back (none at all from a home-screen
// icon) and doesn't download. So there Download opens the share sheet with the PDF
// attached instead: Save to Files, Print, AirDrop, Messages. The share sheet only opens
// straight from a tap, so each shown match's PDF is fetched ahead of time.
const shareSheet = CFG.public && matchMedia("(pointer: coarse)").matches && !!navigator.canShare &&
  navigator.canShare({ files: [new File([""], "x.pdf", { type: "application/pdf" })] });
const pdfFiles = new Map();   // url -> Promise<File>
function pdfFile(m) {
  const url = matchURL(m, true);
  if (!pdfFiles.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(r.status);
      return r.blob();
    }).then((b) => new File([b], matchFile(m), { type: "application/pdf" }));
    p.catch(() => pdfFiles.delete(url));   // try again on the next tap
    pdfFiles.set(url, p);
  }
  return pdfFiles.get(url);
}
async function sharePDF(m, button) {
  const text = button.textContent;
  try {
    const file = await pdfFile(m);
    await navigator.share({ files: [file], title: file.name });
  } catch (e) {
    if (e.name === "AbortError") return;   // closed the share sheet
    // NotAllowedError: the PDF was still loading, so the tap had expired. It's here now.
    button.textContent = e.name === "NotAllowedError" ? "Ready: tap again" : "Couldn't load it: tap to retry";
    setTimeout(() => { button.textContent = text; }, 4000);
  }
}

function fill(select, items, value) {
  select.replaceChildren(...items.map(([v, t]) => el("option", { value: v }, t)));
  if (value != null && items.some(([v]) => String(v) === String(value))) select.value = value;
}
function fillTeams(value) {
  fill($("team"), [["", "All teams"], ...(catalog.teams[div()] || []).map((t) => [t.code, team(t.code, t.name)])], value);
}

// Keep the address bar in step, so it can be shared: ?div=F&week=10&team=F7
function syncURL() {
  const q = new URLSearchParams({ div: div(), week: $("week").value });
  if ($("team").value) q.set("team", $("team").value);
  history.replaceState(null, "", `?${q}`);
}

function matchCard(m, mine) {
  const dl = el("a", { className: "button", href: matchURL(m, true) }, "Download (Front + Back)");
  if (CFG.public) dl.download = matchFile(m);
  if (shareSheet) {
    pdfFile(m);
    dl.addEventListener("click", (e) => { e.preventDefault(); sharePDF(m, dl); });
  }
  return el("div", { className: `match${mine ? " mine" : ""}` },
    mine ? el("p", { className: "tag-mine" }, "Your match") : null,
    el("h3", {}, label(m.home), el("span", { className: "vs" }, " (home) vs "), label(m.away)),
    m.venue ? el("p", { className: "venue" }, `at ${m.venue}`) : null,
    el("div", { className: "actions" }, dl));
}

function render() {
  const w = week(), mineCode = $("team").value;
  const matches = (w && w.divisions[div()]) || [];
  const byes = (w && w.byes[div()]) || [];
  syncURL();
  // Your team: its match first and highlighted, or a note that it's on its bye week.
  const isMine = (m) => mineCode && (m.home_code === mineCode || m.away_code === mineCode);
  const myBye = byes.find((b) => b.code === mineCode);
  $("mine").replaceChildren(...(myBye ? [el("p", { className: "bye mine-bye" }, `${myBye.name} has a BYE week`, el("br"), "No scoresheet this week")] : []));
  if (!matches.length) {
    $("matches").replaceChildren(el("p", { className: "empty" }, "No scoresheets for this division and week yet. ",
      el("button", { type: "button", className: "link-button", onclick: () => location.reload() }, "Reload")));
    return;
  }
  const ordered = [...matches.filter(isMine), ...matches.filter((m) => !isMine(m))];
  $("matches").replaceChildren(...ordered.map((m) => matchCard(m, isMine(m))),
    ...byes.filter((b) => b !== myBye).map((b) => el("p", { className: "bye" }, `${b.name} has a BYE week`)));
}

// The public form's "I'm not a robot" check (Cloudflare Turnstile).
function setupTurnstile() {
  if (!CFG.public) return;
  // Its script loads on its own schedule (async), so wait for it rather than for a page event.
  const go = (tries = 0) => {
    if (window.turnstile) {
      try { turnstileId = turnstile.render("#turnstile", { sitekey: CFG.turnstileSiteKey }); }
      catch (e) { console.warn("Turnstile:", e); }   // the sign-up says to try again; the page still works
    }
    else if (tries < 100) setTimeout(() => go(tries + 1), 100);
  };
  go();
}

async function signup(e) {
  e.preventDefault();
  const msg = $("signup-msg");
  const email = $("email").value.trim(), division = $("signup-division").value;
  if (!email || !$("email").checkValidity()) { msg.className = "err"; msg.textContent = "Please enter a valid email address."; return; }
  if (!division) { msg.className = "err"; msg.textContent = "Please choose your division."; return; }
  const body = { email, division };
  if (CFG.public) {
    body.turnstile = window.turnstile ? turnstile.getResponse(turnstileId) : "";
    if (!body.turnstile) { msg.className = "err"; msg.textContent = "Please complete the \"I'm not a robot\" check first."; return; }
  }
  try {
    const r = await fetch(CFG.public ? `${CFG.signupURL}/api/signup` : "/api/signup",
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    msg.className = j.ok ? "ok" : "err";
    msg.textContent = j.message;
    if (j.ok) $("email").value = "";
  } catch {
    msg.className = "err"; msg.textContent = "Couldn't sign you up just now. Please try again.";
  }
  if (CFG.public && window.turnstile) turnstile.reset(turnstileId);   // a check token works once
}

// A phone's home-screen app picks up where it left off instead of reloading; if a newer
// deploy is out, load it (the ?v= gets past the cache). Public site only.
async function reloadIfNewDeploy() {
  if (!CFG.public || document.visibilityState !== "visible") return;
  try {
    const { v } = await (await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" })).json();
    if (v && v !== CFG.version && new URLSearchParams(location.search).get("v") !== v) {
      const q = new URLSearchParams(location.search); q.set("v", v);
      location.replace(`${location.pathname}?${q}`);
    }
  } catch { /* offline: keep what's showing */ }
}

// The list of weeks and matches. An iPhone home-screen icon often opened on "No scoresheets"
// until a reload: it can start from a stale copy of the page and its data, or before the
// network is ready. So: always ask the server (no-store), try a few times, and use the
// newest version.json's stamp so a stale page still gets the current list.
async function loadCatalog() {
  if (!CFG.public) return (await fetch("/api/catalog", { cache: "no-store" })).json();
  let v = CFG.version;
  try { v = (await (await fetch(`version.json?t=${Date.now()}`, { cache: "no-store" })).json()).v || v; } catch { /* keep the page's */ }
  for (let tries = 0; ; tries++) {
    try {
      const c = await (await fetch(`data/catalog.json?v=${v}`, { cache: "no-store" })).json();
      if (c.weeks && c.weeks.length) return c;
    } catch (e) { if (tries >= 3) throw e; }
    if (tries >= 3) return { weeks: [], teams: {}, name: "", current: null };
    await new Promise((r) => setTimeout(r, 700 * (tries + 1)));
  }
}

async function start() {
  catalog = await loadCatalog();
  $("season").textContent = `${catalog.name} season`;
  // A shared link (?div=F&week=10&team=F7) wins over what this browser remembers.
  const q = new URLSearchParams(location.search);
  const divs = LETTERS.map((l) => [l, `${l} Division`]);
  fill($("division"), divs, (q.get("div") || store.get("div") || "A").toUpperCase());
  fill($("signup-division"), [["", "Choose…"], ...divs], store.get("div") || "");
  const asked = q.get("week");
  fill($("week"), catalog.weeks.map((w) => [w.number, w.label]),
    catalog.weeks.some((w) => String(w.number) === asked) ? asked : catalog.current);
  fillTeams((q.get("team") || store.get("team") || "").toUpperCase());

  $("division").addEventListener("change", () => {
    store.set("div", div());
    const mine = store.get("team");
    fillTeams(mine && mine[0] === div() ? mine : "");
    render();
  });
  $("week").addEventListener("change", render);
  $("team").addEventListener("change", () => { store.set("team", $("team").value); render(); });
  $("signup").addEventListener("submit", signup);
  document.addEventListener("visibilitychange", reloadIfNewDeploy);
  window.addEventListener("pageshow", reloadIfNewDeploy);
  // The matches first: a problem with the sign-up form's robot check must never stop them
  // showing (it did on iPhone home-screen launches: "Couldn't load the scoresheets").
  render();
  try { setupTurnstile(); } catch (e) { console.warn("Turnstile:", e); }
}
// Help popup: the ? opens it. Set up before loading the catalog, so Help works even if that fails.
$("help-open").addEventListener("click", () => $("help").showModal());
// The footer's License link (public site) opens the license in a popup, like Help, instead
// of leaving the page with no way back (LICENSE.txt is still the link for no-JS / new tab).
async function openLicense(e) {
  const a = e.target.closest('a[href="LICENSE.txt"]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  const box = document.getElementById("license-text");
  if (!box.childElementCount) {
    try {
      const text = await (await fetch("LICENSE.txt")).text();
      // The file's lines are wrapped: one paragraph per blank-line-separated block.
      box.replaceChildren(...text.trim().split(/\n\s*\n/).map((para) =>
        Object.assign(document.createElement("p"), { textContent: para.replace(/\n/g, " ") })));
    } catch { location.href = a.href; return; }
  }
  document.getElementById("license").showModal();
}
document.addEventListener("click", openLicense);
// Every popup (Help, License): ×, Esc or a tap outside it closes it.
document.querySelectorAll("dialog.popup").forEach((d) => {
  d.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => d.close()));
  d.addEventListener("click", (e) => { if (e.target === d) d.close(); });
});

start().catch(() => {
  $("matches").replaceChildren(el("p", { className: "empty" }, "Couldn't load the scoresheets. ",
    el("button", { type: "button", className: "link-button", onclick: () => location.reload() }, "Reload")));
});
