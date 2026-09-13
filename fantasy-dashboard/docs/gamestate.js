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

// ESPN's "possessionText" is where the ball is, e.g. "DET 35": the side
// of the field (a team abbreviation) and the yard line on that side.
function parseBallSpot(possessionText) {
  const m = /^([A-Z]{2,3})\s+(\d{1,2})$/.exec((possessionText || "").trim());
  return m ? { side: normalizeTeamAbbr(m[1]), yard: Number(m[2]) } : null;
}

// Returns { [teamAbbr]: { inRedZone, hasPossession, possessionKnown,
// state, period, displayClock, down, downText, ballSpot, teamScore,
// oppScore, oppAbbr, isHome } } for every team on today's scoreboard.
// Teams not playing this week are simply absent.
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
    // Down is a game-level fact, shown for players on both teams. ESPN
    // reports down <= 0 between plays that have none (kickoffs, PATs).
    const down = situation && situation.down > 0 ? situation.down : null;
    const downText =
      down && situation
        ? situation.shortDownDistanceText || `${PERIOD_LABELS[down]} & ${situation.distance}`
        : null;
    const ballSpot = situation ? parseBallSpot(situation.possessionText) : null;

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
        possessionKnown: possessionId != null,
        state,
        period,
        displayClock,
        down,
        downText,
        ballSpot,
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

// Quarter as "Q1".."Q4" (or "OT") so it can't be confused with the down
// ("3rd & 7") sitting right next to it.
function quarterLabel(period) {
  if (period >= 1 && period <= 4) return `Q${period}`;
  return period > 4 ? "OT" : "";
}

// A player's live game line — "3rd & 7 · Q2 5:32 · 20-19 v DET" — or
// null before kickoff, since the existing "Not started" stat line already
// covers that case and there's no score/clock worth showing yet.
function formatGameStatus(situation) {
  if (!situation || situation.teamScore == null || situation.oppScore == null || !situation.oppAbbr) {
    return null;
  }
  const scoreline = `${situation.teamScore}-${situation.oppScore}`;
  const oppText = `${situation.isHome ? "v" : "@"} ${situation.oppAbbr}`;
  if (situation.state === "post") return `Final · ${scoreline} ${oppText}`;
  if (situation.state === "in") {
    const clock = `${quarterLabel(situation.period)} ${situation.displayClock}`.trim();
    return [situation.downText, clock, `${scoreline} ${oppText}`].filter(Boolean).join(" · ");
  }
  return null;
}

// Whether a player is on the field for the current play, going by who
// has the ball: offense when their team does, a defense when the other
// team does. A kicker only counts on 4th down in field goal range (inside
// the opponent's 40) — the feed doesn't say when a kick is actually
// coming, so that's the closest honest guess.
const FIELD_GOAL_RANGE_YARDS = 40;

function isOnField(situation, pos) {
  if (!situation || situation.state !== "in" || !situation.possessionKnown) return false;
  if (pos === "DEF") return !situation.hasPossession;
  if (!situation.hasPossession) return false;
  if (pos === "K") {
    const spot = situation.ballSpot;
    return (
      situation.down === 4 &&
      !!spot &&
      spot.side === situation.oppAbbr &&
      spot.yard <= FIELD_GOAL_RANGE_YARDS
    );
  }
  return true;
}
