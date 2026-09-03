// ── This week's matchup ──────────────────────────────────────────────
// Edit this file each week after sending Claude a photo of the matchup.
// Leave season/week as null to auto-detect the current NFL week.
//
// Each player needs: name, sleeper_id, pos, team
// (sleeper_id is looked up from Sleeper's player list — Claude fills this
// in for you from the roster photo, you shouldn't need to type these.)
//
// NOTE: this file is duplicated from ../lib/matchup.js because this is
// the static (GitHub Pages) build — it has no server to share code with.
// Keep both in sync when you edit your roster.
//
// This is only the FALLBACK roster shown before anyone sets one from a
// photo (see roster-import.js). Once a roster is set, it's carried in
// the page URL (#roster=...) and in this browser's localStorage instead.

const DEFAULT_MATCHUP = {
  season: null,
  week: null,

  teamA: {
    name: "My Team",
    players: [
      { name: "Aaron Rodgers", sleeper_id: "96", pos: "QB", team: "PIT" },
      { name: "D'Andre Swift", sleeper_id: "6790", pos: "RB", team: "CHI" },
      { name: "James Cook", sleeper_id: "8138", pos: "RB", team: "BUF" },
      { name: "Ja'Marr Chase", sleeper_id: "7564", pos: "WR", team: "CIN" },
    ],
  },

  teamB: {
    name: "Opponent",
    players: [
      { name: "Caleb Williams", sleeper_id: "11560", pos: "QB", team: "CHI" },
      { name: "Derrick Henry", sleeper_id: "3198", pos: "RB", team: "BAL" },
      { name: "Bucky Irving", sleeper_id: "11584", pos: "RB", team: "TB" },
      { name: "Davante Adams", sleeper_id: "2133", pos: "WR", team: "LAR" },
    ],
  },
};
