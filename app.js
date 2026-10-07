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
    $("matches").replaceChildren(el("p", { className: "empty" }, "No scoresheets for this division and week yet."));
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
    if (window.turnstile) turnstileId = turnstile.render("#turnstile", { sitekey: CFG.turnstileSiteKey });
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

async function start() {
  catalog = await (await fetch(CFG.public ? `data/catalog.json?v=${CFG.version}` : "/api/catalog")).json();
  $("season").textContent = `${catalog.name} season`;
  // A shared link (?div=F&week=10&team=F7) wins over what this browser remembers.
  const q = new URLSearchParams(location.search);
  const divs = LETTERS.map((l) => [l, `${l} Division`]);
  fill($("division"), divs, (q.get("div") || store.get("div") || "A").toUpperCase());
  fill($("signup-division"), [["", "Choose…"], ...divs], store.get("div") || "");
  fill($("week"), catalog.weeks.map((w) => [w.number, w.label]), q.get("week") || catalog.current);
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
  setupTurnstile();
  render();
}
// Help popup: the ? opens it; ×, Close, Esc or a tap outside it closes it. Set up
// before loading the catalog, so Help works even if that fails.
function setupHelp() {
  const help = $("help");
  $("help-open").addEventListener("click", () => help.showModal());
  help.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => help.close()));
  help.addEventListener("click", (e) => { if (e.target === help) help.close(); });
}

setupHelp();
start().catch(() => { $("matches").replaceChildren(el("p", { className: "empty" }, "Couldn't load the scoresheets.")); });
