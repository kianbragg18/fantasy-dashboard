// ── Live red zone / possession info ──────────────────────────────────
// Sleeper's API has no down/distance/possession/red-zone data anywhere
// in what it publishes — confirmed by inspecting both its documented
// stats endpoint and its own live-score feed. This pulls that from
// ESPN's public scoreboard feed instead, which does carry it.
//
// That feed is NOT an official, versioned, or documented API — it's
// the same one ESPN's own site/app uses internally. If ESPN ever
// changes its shape, this fails silently (see the .catch where it's
// called) and the app just stops showing red zone highlights; it
// won't break scores or anything else.

const ESPN_SCOREBOARD_URL = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";

// ESPN spells Washington's abbreviation differently than Sleeper does.
// Every other team abbreviation matches across both APIs.
const TEAM_ABBR_FIXUP = { WSH: "WAS" };

function normalizeTeamAbbr(abbr) {
  return TEAM_ABBR_FIXUP[abbr] || abbr;
}

// Returns { [teamAbbr]: { inRedZone, hasPossession, state, period,
// displayClock, teamScore, oppScore, oppAbbr, isHome } } for every team
// currently playing. Teams not in a game right now are simply absent.
async function fetchGameSituations() {
  const res = await fetch(ESPN_SCOREBOARD_URL);
  if (!res.ok) throw new Error(`ESPN scoreboard fetch failed: ${res.status}`);
  const data = await res.json();

  const byTeam = {};
  for (const event of data.events || []) {
    const comp = event.competitions && event.competitions[0];
    if (!comp) continue;
    const situation = comp.situation;
    const isRedZone = !!(situation && situation.isRedZone);
    const possessionId = situation && situation.possession;

    const status = comp.status || {};
    const state = status.type && status.type.state; // "pre" | "in" | "post"
    const period = status.period || 0;
    const displayClock = status.displayClock || "";

    const competitors = comp.competitors || [];
    const home = competitors.find((c) => c.homeAway === "home");
    const away = competitors.find((c) => c.homeAway === "away");

    for (const competitor of competitors) {
      if (!competitor.team) continue;
      const abbr = normalizeTeamAbbr(competitor.team.abbreviation);
      const hasPossession = possessionId != null && String(possessionId) === String(competitor.id);
      const opponent = competitor.homeAway === "home" ? away : home;
      byTeam[abbr] = {
        inRedZone: hasPossession && isRedZone,
        hasPossession,
        state,
        period,
        displayClock,
        teamScore: competitor.score != null ? Number(competitor.score) : null,
        oppScore: opponent && opponent.score != null ? Number(opponent.score) : null,
        oppAbbr: opponent && opponent.team ? normalizeTeamAbbr(opponent.team.abbreviation) : null,
        isHome: competitor.homeAway === "home",
      };
    }
  }
  return byTeam;
}

const PERIOD_LABELS = { 1: "1st", 2: "2nd", 3: "3rd", 4: "4th" };

function periodLabel(period) {
  if (PERIOD_LABELS[period]) return PERIOD_LABELS[period];
  return period > 4 ? "OT" : "";
}

// A player's live game line — "4th 5:00 · 20-19 v DET" — or null before
// kickoff, since the existing "Not started" stat line already covers
// that case and there's no score/clock worth showing yet.
function formatGameStatus(situation) {
  if (!situation || situation.teamScore == null || situation.oppScore == null || !situation.oppAbbr) {
    return null;
  }
  const scoreline = `${situation.teamScore}-${situation.oppScore}`;
  const oppText = `${situation.isHome ? "v" : "@"} ${situation.oppAbbr}`;
  if (situation.state === "post") return `Final · ${scoreline} ${oppText}`;
  if (situation.state === "in") return `${periodLabel(situation.period)} ${situation.displayClock} · ${scoreline} ${oppText}`;
  return null;
}
