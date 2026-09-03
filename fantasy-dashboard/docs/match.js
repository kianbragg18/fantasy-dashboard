// ── Name matching helpers ────────────────────────────────────────────
// Pure string logic used to match OCR'd text against Sleeper's player
// list. No DOM/fetch here so it can be unit tested in plain Node.

const SUFFIXES = new Set(["jr", "sr", "ii", "iii", "iv", "v"]);

function normalize(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .replace(/[.'`]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !SUFFIXES.has(w))
    .join(" ")
    .trim();
}

function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    let cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev.splice(0, prev.length, ...cur);
  }
  return prev[b.length];
}

function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

// Scores one OCR'd line against every player, returns the best `topN`
// candidates with score >= MIN_SCORE, highest first.
const MIN_SCORE = 0.45;

function scorePlayer(norm, player) {
  if (!norm || !player.norm) return 0;
  if (player.norm === norm) return 1;
  if (player.norm.includes(norm) || norm.includes(player.norm)) {
    const lenRatio = Math.min(norm.length, player.norm.length) / Math.max(norm.length, player.norm.length);
    return 0.75 + 0.2 * lenRatio;
  }
  const full = similarity(norm, player.norm);
  const lastNameOnly = player.lastNorm && (norm === player.lastNorm || norm.endsWith(" " + player.lastNorm));
  const lastBoost = lastNameOnly ? 0.25 : 0;
  return Math.min(0.94, full + lastBoost);
}

function matchLine(lineText, playersDb, topN = 3) {
  const norm = normalize(lineText);
  if (norm.length < 3) return [];
  const scored = playersDb
    .map((p) => ({ player: p, score: scorePlayer(norm, p) }))
    .filter((s) => s.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score);
  return scored.slice(0, topN);
}

function extractCandidateLines(ocrText) {
  const seen = new Set();
  const lines = [];
  for (const raw of ocrText.split(/\n+/)) {
    const line = raw.replace(/[^a-zA-Z.'\- ]/g, " ").replace(/\s+/g, " ").trim();
    if (line.length < 3 || line.length > 40) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { normalize, levenshtein, similarity, matchLine, extractCandidateLines };
}
