const POLL_MS = 15000;
const OVERRIDE_STORAGE_KEY = "ffMatchupOverrideV1";

const $ = (sel) => document.querySelector(sel);

let pollTimer = null;

// Which players' point breakdowns are expanded, and the data needed to
// redraw the rows without a network refetch (kept so tapping a row to
// expand it doesn't wait on Sleeper/ESPN, and survives real refreshes
// since it's keyed by sleeper_id rather than tied to one render pass).
const expandedPlayers = new Set();
let lastRenderData = null;

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

function computePlayer(p, statsByPlayer, situationsByTeam) {
  const s = statsByPlayer[p.sleeper_id];
  const situation = p.team && situationsByTeam[p.team];
  return {
    p,
    stats: s,
    pts: calcPoints(s, p.pos),
    line: formatStatLine(p.pos, s),
    inRedZone: !!(situation && situation.inRedZone),
    gameStatus: situation ? formatGameStatus(situation) : null,
  };
}

function breakdownHtml(stats, pos) {
  const items = pointsBreakdown(stats, pos);
  if (!items.length) {
    return `<div class="mbreakdown"><div class="mbreak-empty">No scoring stats yet</div></div>`;
  }
  const rows = items
    .map(
      (item) => `
        <div class="mbreak-row">
          <span class="mbreak-label">${item.label}</span>
          <span class="mbreak-raw">${item.raw}</span>
          <span class="mbreak-pts">${item.pts >= 0 ? "+" : ""}${item.pts.toFixed(1)}</span>
        </div>`
    )
    .join("");
  return `<div class="mbreakdown">${rows}</div>`;
}

function sideHtml(entry, side) {
  if (!entry) {
    return `<div class="mside ${side} empty-slot">—</div>`;
  }
  const key = entry.p.sleeper_id;
  const isExpanded = expandedPlayers.has(key);
  const rzBadge = entry.inRedZone ? `<span class="rz-badge">RZ</span>` : "";
  const teamBadge = entry.p.team ? `<span class="mteam">${entry.p.team}</span>` : "";
  const cls = side + (entry.inRedZone ? " redzone" : "") + (isExpanded ? " expanded" : "");
  return `
    <div class="mside ${cls}" data-player-id="${key}" role="button" tabindex="0" aria-expanded="${isExpanded}">
      <div class="mtop">
        <span class="mname">${entry.p.name}${rzBadge}</span>
        <span class="mpts">${entry.pts.toFixed(1)}</span>
      </div>
      <div class="mline">${teamBadge}${entry.line}</div>
      ${entry.gameStatus ? `<div class="mgame">${entry.gameStatus}</div>` : ""}
      ${isExpanded ? breakdownHtml(entry.stats, entry.p.pos) : ""}
    </div>
  `;
}

// Pairs each team's players up by roster slot (index) so, e.g., teamA's
// first RB lines up against teamB's first RB — mirrors how fantasy apps
// show a matchup as one row per position rather than two stacked lists.
function renderMatchupRows(container, teamA, teamB, statsByPlayer, situationsByTeam) {
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
    const ca = pa ? computePlayer(pa, statsByPlayer, situationsByTeam) : null;
    const cb = pb ? computePlayer(pb, statsByPlayer, situationsByTeam) : null;
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

    const [stats, situationsByTeam] = await Promise.all([
      fetchStats(season, week, season_type),
      fetchGameSituations().catch((err) => {
        console.warn("Red zone data unavailable (non-fatal):", err.message);
        return {};
      }),
    ]);

    lastRenderData = { matchup, stats, situationsByTeam };
    const { totalA, totalB } = renderMatchupRows(
      $("#matchup-rows"),
      matchup.teamA,
      matchup.teamB,
      stats,
      situationsByTeam
    );

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

// Redraws the rows from the last fetched data (no network call) — used
// when tapping a player to expand/collapse their point breakdown, so
// it's instant and doesn't disturb the poll cycle.
function rerenderRows() {
  if (!lastRenderData) return;
  const { matchup, stats, situationsByTeam } = lastRenderData;
  renderMatchupRows($("#matchup-rows"), matchup.teamA, matchup.teamB, stats, situationsByTeam);
}

function toggleExpanded(playerId) {
  if (expandedPlayers.has(playerId)) {
    expandedPlayers.delete(playerId);
  } else {
    expandedPlayers.add(playerId);
  }
  rerenderRows();
}

$("#matchup-rows").addEventListener("click", (e) => {
  const side = e.target.closest(".mside[data-player-id]");
  if (side) toggleExpanded(side.dataset.playerId);
});
$("#matchup-rows").addEventListener("keydown", (e) => {
  if (e.key !== "Enter" && e.key !== " ") return;
  const side = e.target.closest(".mside[data-player-id]");
  if (side) {
    e.preventDefault();
    toggleExpanded(side.dataset.playerId);
  }
});

$("#refresh").addEventListener("click", refresh);

// Exposed so roster-import.js can force a re-render right after the
// user saves a new roster from a photo, without waiting for the poll.
window.ffRefreshMatchup = refresh;

// When cloud sync is configured (firebase-config.js), whichever roster
// was last saved from either phone becomes the shared source of truth
// — this fires immediately with whatever's already saved, then again
// on every future change, from either device, in real time.
if (isCloudSyncEnabled()) {
  watchMatchupFromCloud((matchup) => {
    window.__ffOverride = matchup;
    try {
      localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(matchup));
    } catch {}
    refresh();
  });
}

refresh();
startPolling();
