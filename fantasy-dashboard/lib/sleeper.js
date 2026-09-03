const MATCHUP = require("./matchup");
const { calcPoints, formatStatLine } = require("./scoring");

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes — avoids hammering the Sleeper API

// ── TEMPORARY DEMO OVERRIDE ──────────────────────────────────────────
// Fakes James Cook's live stat line on top of whatever real (currently
// empty, pre-season) data comes back, just to prove the scoring math
// and UI update live. Remove this block once the season actually starts.
const DEMO_OVERRIDE = {
  "8138": { rush_att: 18, rush_yd: 100, rush_td: 2, rec: 4 }, // James Cook
};
// ──────────────────────────────────────────────────────────────────────

let cache = { data: null, fetchedAt: 0 };

async function getSeasonWeek() {
  if (MATCHUP.season && MATCHUP.week) {
    return { season: MATCHUP.season, week: MATCHUP.week, season_type: "regular" };
  }
  const res = await fetch("https://api.sleeper.app/v1/state/nfl");
  if (!res.ok) throw new Error(`State fetch failed: ${res.status}`);
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

function buildTeam(team, statsByPlayer) {
  let total = 0;
  const players = team.players.map((p) => {
    const s = statsByPlayer[p.sleeper_id];
    const pts = calcPoints(s);
    total += pts;
    return {
      name: p.name,
      pos: p.pos,
      team: p.team,
      pts,
      line: formatStatLine(p.pos, s),
    };
  });
  return { name: team.name, total, players };
}

async function fetchFreshData() {
  const { season, week, season_type } = await getSeasonWeek();
  const stats = await fetchStats(season, week, season_type);
  return {
    season,
    week,
    teamA: buildTeam(MATCHUP.teamA, stats),
    teamB: buildTeam(MATCHUP.teamB, stats),
    fetchedAt: new Date().toISOString(),
  };
}

// Serves cached data for up to CACHE_TTL_MS. Pass force:true (from the
// UI's refresh button) to bypass the cache. Falls back to stale cache
// data if a refresh attempt fails, rather than breaking the page.
async function getMatchupData({ force = false } = {}) {
  const isStale = Date.now() - cache.fetchedAt > CACHE_TTL_MS;
  if (!cache.data || isStale || force) {
    try {
      cache = { data: await fetchFreshData(), fetchedAt: Date.now() };
    } catch (err) {
      if (cache.data) {
        console.error("Refresh failed, serving stale cache:", err.message);
      } else {
        throw err;
      }
    }
  }
  return cache.data;
}

module.exports = { getMatchupData };
