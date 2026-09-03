const POLL_MS = 30000;
const OVERRIDE_STORAGE_KEY = "ffMatchupOverrideV1";

// ── TEMPORARY DEMO OVERRIDE ──────────────────────────────────────────
// Fakes James Cook's live stat line on top of whatever real (currently
// empty, pre-season) data comes back, just to prove the scoring math
// and UI update live. Remove this block once the season actually starts.
const DEMO_OVERRIDE = {
  "8138": { rush_att: 18, rush_yd: 100, rush_td: 2, rec: 4 }, // James Cook
};
// ──────────────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);

let pollTimer = null;

// A roster set via the photo-upload panel lives in the URL hash (so it
// can be shared with a link) and in localStorage (so it survives a
// reload on the same browser without the hash). Falls back to the
// hardcoded DEFAULT_MATCHUP from roster.js.
function decodeRosterFromHash() {
  const match = window.location.hash.match(/roster=([^&]+)/);
  if (!match) return null;
  try {
    return JSON.parse(decodeURIComponent(escape(atob(match[1]))));
  } catch (err) {
    console.warn("Could not parse roster from URL:", err);
    return null;
  }
}

function loadStoredOverride() {
  try {
    const raw = localStorage.getItem(OVERRIDE_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function getActiveMatchup() {
  if (window.__ffOverride) return window.__ffOverride;
  const fromHash = decodeRosterFromHash();
  if (fromHash) {
    window.__ffOverride = fromHash;
    try {
      localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(fromHash));
    } catch {}
    return fromHash;
  }
  const stored = loadStoredOverride();
  if (stored) {
    window.__ffOverride = stored;
    return stored;
  }
  return DEFAULT_MATCHUP;
}

async function getSeasonWeek(matchup) {
  if (matchup.season && matchup.week) {
    return { season: matchup.season, week: matchup.week, season_type: "regular" };
  }
  const res = await fetch("https://api.sleeper.app/v1/state/nfl");
  const state = await res.json();
  return {
    season: matchup.season || state.season,
    week: matchup.week || state.week,
    season_type: state.season_type || "regular",
  };
}

async function fetchStats(season, week, seasonType) {
  const url = `https://api.sleeper.app/v1/stats/nfl/${seasonType}/${season}/${week}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Stats fetch failed: ${res.status}`);
  const data = await res.json();
  return { ...data, ...DEMO_OVERRIDE };
}

function renderPlayer(p, statsByPlayer) {
  const s = statsByPlayer[p.sleeper_id];
  const pts = calcPoints(s);
  const line = formatStatLine(p.pos, s);
  const el = document.createElement("div");
  el.className = "player";
  el.innerHTML = `
    <div class="info">
      <div class="pname">${p.name}<span class="badge">${p.pos}${p.team ? " · " + p.team : ""}</span></div>
      <div class="line">${line}</div>
    </div>
    <div class="pts">${pts.toFixed(1)}</div>
  `;
  return { el, pts };
}

function renderTeam(colEl, team, statsByPlayer) {
  colEl.innerHTML = "";
  if (!team.players.length) {
    colEl.innerHTML = `<div class="empty">No roster loaded yet — use "Set rosters from a photo" below.</div>`;
    return 0;
  }
  let total = 0;
  for (const p of team.players) {
    const { el, pts } = renderPlayer(p, statsByPlayer);
    colEl.appendChild(el);
    total += pts;
  }
  return total;
}

async function refresh() {
  const btn = $("#refresh");
  const statusText = $("#status-text");
  const dot = $("#dot");
  btn.disabled = true;
  statusText.textContent = "Updating…";

  try {
    const matchup = getActiveMatchup();
    const { season, week, season_type } = await getSeasonWeek(matchup);
    $("#meta").textContent = `${season} · Week ${week}`;

    const stats = await fetchStats(season, week, season_type);

    const totalA = renderTeam($("#col-a"), matchup.teamA, stats);
    const totalB = renderTeam($("#col-b"), matchup.teamB, stats);

    $("#name-a").textContent = matchup.teamA.name;
    $("#name-b").textContent = matchup.teamB.name;
    $("#col-a-title").textContent = matchup.teamA.name;
    $("#col-b-title").textContent = matchup.teamB.name;
    $("#pts-a").textContent = totalA.toFixed(1);
    $("#pts-b").textContent = totalB.toFixed(1);

    const sum = totalA + totalB || 1;
    $("#bar-a").style.width = `${(totalA / sum) * 100}%`;
    $("#bar-b").style.width = `${(totalB / sum) * 100}%`;

    dot.classList.add("live");
    const now = new Date();
    $("#last-updated").textContent = `Data last updated ${now.toLocaleTimeString()}`;
    statusText.textContent = `Updated ${now.toLocaleTimeString()}`;
  } catch (err) {
    dot.classList.remove("live");
    statusText.textContent = "Update failed — will retry";
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, POLL_MS);
}

$("#refresh").addEventListener("click", refresh);

// Exposed so roster-import.js can force a re-render right after the
// user saves a new roster from a photo, without waiting for the poll.
window.ffRefreshMatchup = refresh;

refresh();
startPolling();
