// ── League scoring rules ─────────────────────────────────────────────
// Passing / rushing / receiving TD = 6 pts each
// 10 rushing/receiving yards = 1 pt
// 25 passing yards = 1 pt
// Reception = 1 pt (full PPR)
// Kicker: FG <40yd = 3, 40-49yd = 4, 50+yd = 5, PAT made = 1,
// missed FG or PAT = -1 each.

// Sleeper's stats feed doesn't give individual kick distances, only
// made/missed counts bucketed by distance range — so buckets are
// mapped straight to the 3/4/5 tiers instead of checking each kick.
function calcKickerPoints(s) {
  let pts = 0;
  pts += (s.fgm_0_19 || 0) * 3;
  pts += (s.fgm_20_29 || 0) * 3;
  pts += (s.fgm_30_39 || 0) * 3;
  pts += (s.fgm_40_49 || 0) * 4;
  pts += (s.fgm_50_59 || 0) * 5;
  pts += (s.fgm_60p || 0) * 5;
  pts += (s.xpm || 0) * 1;
  pts -= (s.fgmiss || 0) * 1;
  pts -= (s.xpmiss || 0) * 1;
  return pts;
}

// Points-allowed tiers, standard Sleeper/Yahoo scale: (max points allowed
// inclusive, fantasy points). Sleeper's stats feed reports total points
// allowed as one number (`pts_allow`), with no split for how many of those
// came off the defense's own offense's turnovers, so that's all this tier
// lookup can key off.
const POINTS_ALLOWED_TIERS = [
  [0, 10],
  [6, 7],
  [13, 4],
  [20, 1],
  [27, 0],
  [34, -1],
  [Infinity, -4],
];

function pointsAllowedTierPts(pointsAllowed) {
  for (const [ceiling, pts] of POINTS_ALLOWED_TIERS) {
    if (pointsAllowed <= ceiling) return pts;
  }
  return -4;
}

// Sleeper reports `td` as every TD scored by the D/ST unit (return TDs
// included) and `def_td` as just the defensive subset (INT/fumble return),
// so the special-teams TD count is the difference between the two.
function specialTeamsTds(s) {
  return Math.max((s.td || 0) - (s.def_td || 0), 0);
}

function calcDefensePoints(s) {
  let pts = 0;
  pts += (s.sack || 0) * 1;
  pts += (s.int || 0) * 2;
  pts += (s.fum_rec || 0) * 2;
  pts += (s.ff || 0) * 1;
  pts += (s.safe || 0) * 2;
  pts += (s.blk_kick || 0) * 2;
  pts += (s.def_td || 0) * 6;
  pts += specialTeamsTds(s) * 6;
  pts += (s.def_2pt || 0) * 2;
  pts += pointsAllowedTierPts(s.pts_allow || 0);
  return pts;
}

function calcPoints(stats, pos) {
  if (!stats) return 0;
  if (pos === "K") return calcKickerPoints(stats);
  if (pos === "DEF") return calcDefensePoints(stats);
  let pts = 0;
  pts += (stats.pass_yd || 0) / 25;
  pts += (stats.pass_td || 0) * 6;
  pts += (stats.rush_yd || 0) / 10;
  pts += (stats.rush_td || 0) * 6;
  pts += (stats.rec || 0) * 1;
  pts += (stats.rec_yd || 0) / 10;
  pts += (stats.rec_td || 0) * 6;
  return pts;
}

function kickerBreakdown(s) {
  const items = [
    { label: "FG <40yd", raw: (s.fgm_0_19 || 0) + (s.fgm_20_29 || 0) + (s.fgm_30_39 || 0), perUnit: 3 },
    { label: "FG 40-49yd", raw: s.fgm_40_49 || 0, perUnit: 4 },
    { label: "FG 50+yd", raw: (s.fgm_50_59 || 0) + (s.fgm_60p || 0), perUnit: 5 },
    { label: "PAT made", raw: s.xpm || 0, perUnit: 1 },
    { label: "FG missed", raw: s.fgmiss || 0, perUnit: -1 },
    { label: "PAT missed", raw: s.xpmiss || 0, perUnit: -1 },
  ];
  return items
    .map(({ label, raw, perUnit }) => ({ label, raw, pts: raw * perUnit }))
    .filter((item) => item.raw > 0);
}

function defenseBreakdown(s) {
  const items = [
    { label: "Sacks", raw: s.sack || 0, perUnit: 1 },
    { label: "Interceptions", raw: s.int || 0, perUnit: 2 },
    { label: "Fumble recoveries", raw: s.fum_rec || 0, perUnit: 2 },
    { label: "Forced fumbles", raw: s.ff || 0, perUnit: 1 },
    { label: "Safeties", raw: s.safe || 0, perUnit: 2 },
    { label: "Blocked kicks", raw: s.blk_kick || 0, perUnit: 2 },
    { label: "Defensive TD", raw: s.def_td || 0, perUnit: 6 },
    { label: "Special teams TD", raw: specialTeamsTds(s), perUnit: 6 },
    { label: "2pt return", raw: s.def_2pt || 0, perUnit: 2 },
  ];
  const rows = items
    .map(({ label, raw, perUnit }) => ({ label, raw, pts: raw * perUnit }))
    .filter((item) => item.raw > 0);

  // Points allowed always shows, even at 0 pts, since it's a core part of
  // every D/ST score rather than a bonus category.
  const pointsAllowed = s.pts_allow || 0;
  rows.push({ label: "Points allowed", raw: pointsAllowed, pts: pointsAllowedTierPts(pointsAllowed) });
  return rows;
}

// Same categories/math as calcPoints, but itemized — powers the
// tap-to-expand "how were these points scored" breakdown.
function pointsBreakdown(stats, pos) {
  if (!stats) return [];
  if (pos === "K") return kickerBreakdown(stats);
  if (pos === "DEF") return defenseBreakdown(stats);
  const categories = [
    { key: "pass_yd", label: "Pass yards", divisor: 25 },
    { key: "pass_td", label: "Pass TD", perUnit: 6 },
    { key: "rush_yd", label: "Rush yards", divisor: 10 },
    { key: "rush_td", label: "Rush TD", perUnit: 6 },
    { key: "rec", label: "Receptions", perUnit: 1 },
    { key: "rec_yd", label: "Rec yards", divisor: 10 },
    { key: "rec_td", label: "Rec TD", perUnit: 6 },
  ];
  return categories
    .map(({ key, label, divisor, perUnit }) => {
      const raw = stats[key] || 0;
      const pts = divisor ? raw / divisor : raw * perUnit;
      return { label, raw, pts };
    })
    .filter((item) => item.raw > 0);
}

function formatStatLine(pos, s) {
  if (!s) return "Not started";
  const parts = [];

  if (pos === "K") {
    const fgm = (s.fgm_0_19 || 0) + (s.fgm_20_29 || 0) + (s.fgm_30_39 || 0) + (s.fgm_40_49 || 0) + (s.fgm_50_59 || 0) + (s.fgm_60p || 0);
    const fga = fgm + (s.fgmiss || 0);
    if (fga) parts.push(`${fgm}/${fga} FG`);
    const xpa = (s.xpm || 0) + (s.xpmiss || 0);
    if (xpa) parts.push(`${s.xpm || 0}/${xpa} XP`);
    return parts.length ? parts.join("  ·  ") : "No stats yet";
  }

  if (pos === "DEF") {
    if (s.sack) parts.push(`${s.sack} SACK`);
    if (s.int) parts.push(`${s.int} INT`);
    if (s.fum_rec) parts.push(`${s.fum_rec} FR`);
    const tds = (s.def_td || 0) + specialTeamsTds(s);
    if (tds) parts.push(`${tds} TD`);
    parts.push(`${s.pts_allow || 0} PA`);
    return parts.join("  ·  ");
  }

  if (s.pass_att) {
    parts.push(`${s.pass_cmp || 0}/${s.pass_att} · ${s.pass_yd || 0} YD`);
    if (s.pass_td) parts.push(`${s.pass_td} TD`);
    if (s.pass_int) parts.push(`${s.pass_int} INT`);
  }
  if (s.rush_att) {
    parts.push(`${s.rush_att} CAR · ${s.rush_yd || 0} YD`);
    if (s.rush_td) parts.push(`${s.rush_td} TD`);
  }
  if (s.rec || s.rec_tgt) {
    parts.push(`${s.rec || 0} REC · ${s.rec_yd || 0} YD`);
    if (s.rec_td) parts.push(`${s.rec_td} TD`);
  }
  if (s.fum_lost) parts.push(`${s.fum_lost} FUM`);

  return parts.length ? parts.join("  ·  ") : "No stats yet";
}
