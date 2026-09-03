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

// Returns { [teamAbbr]: { inRedZone, hasPossession } } for every team
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

    for (const competitor of comp.competitors || []) {
      if (!competitor.team) continue;
      const abbr = normalizeTeamAbbr(competitor.team.abbreviation);
      const hasPossession = possessionId != null && String(possessionId) === String(competitor.id);
      byTeam[abbr] = { inRedZone: hasPossession && isRedZone, hasPossession };
    }
  }
  return byTeam;
}
