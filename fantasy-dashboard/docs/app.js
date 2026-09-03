const POLL_MS = 15000;
const OVERRIDE_STORAGE_KEY = "ffMatchupOverrideV1";

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
  return res.json();
}

function computePlayer(p, statsByPlayer) {
  const s = statsByPlayer[p.sleeper_id];
  return { p, pts: calcPoints(s), line: formatStatLine(p.pos, s) };
}

function sideHtml(entry, side) {
  if (!entry) {
    return `<div class="mside ${side} empty-slot">—</div>`;
  }
  return `
    <div class="mside ${side}">
      <div class="mpts">${entry.pts.toFixed(1)}</div>
      <div class="mname">${entry.p.name}${entry.p.team ? `<span class="mteam">${entry.p.team}</span>` : ""}</div>
      <div class="mline">${entry.line}</div>
    </div>
  `;
}

// Pairs each team's players up by roster slot (index) so, e.g., teamA's
// first RB lines up against teamB's first RB — mirrors how fantasy apps
// show a matchup as one row per position rather than two stacked lists.
function renderMatchupRows(container, teamA, teamB, statsByPlayer) {
  container.innerHTML = "";
  const rowCount = Math.max(teamA.players.length, teamB.players.length);

  if (!rowCount) {
    container.innerHTML = `<div class="empty">No roster loaded yet — use "Set rosters from a photo" below.</div>`;
    return { totalA: 0, totalB: 0 };
  }

  let totalA = 0;
  let totalB = 0;

  for (let i = 0; i < rowCount; i++) {
    const pa = teamA.players[i];
    const pb = teamB.players[i];
    const ca = pa ? computePlayer(pa, statsByPlayer) : null;
    const cb = pb ? computePlayer(pb, statsByPlayer) : null;
    if (ca) totalA += ca.pts;
    if (cb) totalB += cb.pts;

    const pos = (pa && pa.pos) || (pb && pb.pos) || "";
    const aWins = ca && cb && ca.pts > cb.pts;
    const bWins = ca && cb && cb.pts > ca.pts;

    const row = document.createElement("div");
    row.className = "mrow";
    row.innerHTML = `
      ${sideHtml(ca, "left" + (aWins ? " winning" : bWins ? " losing" : ""))}
      <div class="mpos">${pos}</div>
      ${sideHtml(cb, "right" + (bWins ? " winning" : aWins ? " losing" : ""))}
    `;
    container.appendChild(row);
  }

  return { totalA, totalB };
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

    const { totalA, totalB } = renderMatchupRows($("#matchup-rows"), matchup.teamA, matchup.teamB, stats);

    $("#name-a").textContent = matchup.teamA.name;
    $("#name-b").textContent = matchup.teamB.name;
    $("#avatar-a").textContent = matchup.teamA.name.trim().charAt(0).toUpperCase() || "A";
    $("#avatar-b").textContent = matchup.teamB.name.trim().charAt(0).toUpperCase() || "B";
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
