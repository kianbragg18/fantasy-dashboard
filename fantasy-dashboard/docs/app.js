const POLL_MS = 30000;

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

async function getSeasonWeek() {
  if (MATCHUP.season && MATCHUP.week) {
    return { season: MATCHUP.season, week: MATCHUP.week, season_type: "regular" };
  }
  const res = await fetch("https://api.sleeper.app/v1/state/nfl");
  const state = await res.json();
  return {
    season: MATCHUP.season || state.season,
    week: MATCHUP.week || state.week,
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
    colEl.innerHTML = `<div class="empty">No roster loaded yet — send Claude a matchup photo to fill this in.</div>`;
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
    const { season, week, season_type } = await getSeasonWeek();
    $("#meta").textContent = `${season} · Week ${week}`;

    const stats = await fetchStats(season, week, season_type);

    const totalA = renderTeam($("#col-a"), MATCHUP.teamA, stats);
    const totalB = renderTeam($("#col-b"), MATCHUP.teamB, stats);

    $("#name-a").textContent = MATCHUP.teamA.name;
    $("#name-b").textContent = MATCHUP.teamB.name;
    $("#col-a-title").textContent = MATCHUP.teamA.name;
    $("#col-b-title").textContent = MATCHUP.teamB.name;
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

refresh();
startPolling();
