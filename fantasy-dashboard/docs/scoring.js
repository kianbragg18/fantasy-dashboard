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

// Same categories/math as calcPoints, but itemized — powers the
// tap-to-expand "how were these points scored" breakdown.
function pointsBreakdown(stats) {
  if (!stats) return [];
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
