// ── League scoring rules ─────────────────────────────────────────────
// Passing / rushing / receiving TD = 6 pts each
// 10 rushing/receiving yards = 1 pt
// 25 passing yards = 1 pt
// Reception = 1 pt (full PPR)

function calcPoints(stats) {
  if (!stats) return 0;
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

function formatStatLine(pos, s) {
  if (!s) return "Not started";
  const parts = [];

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
