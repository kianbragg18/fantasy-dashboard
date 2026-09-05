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

  if (norm === player.lastNorm) return 0.85; // query is just the last name

  // Matchup screens abbreviate to "first-initial lastname" (e.g. "T
  // Hill"), and OCR sometimes drops a first name outright. Either way,
  // whatever precedes a shared last name should be a genuine prefix of
  // the player's real first name — otherwise raw edit-distance favors
  // whichever real player just happens to have a *short* full name
  // (e.g. "KJ Hill" out-scoring the real "Tyreek Hill" for a "T Hill"
  // query, or "A.J. Brown" out-scoring "Amon-Ra St. Brown" for "A St
  // Brown", purely because their names are closer in length).
  if (player.lastNorm && norm.endsWith(" " + player.lastNorm)) {
    const prefix = norm.slice(0, norm.length - player.lastNorm.length - 1).trim();
    if (prefix && player.firstNorm && (prefix === player.firstNorm || player.firstNorm.startsWith(prefix))) {
      return 0.93;
    }
    return 0; // shares a last name, but the first name/initial doesn't match
  }

  return similarity(norm, player.norm);
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

// A matchup screen's position label ("QB", "WR"...) sits between the
// two rosters, right around the photo's midpoint — so it can end up
// tacked onto the start or end of whichever side's line it's closest
// to, e.g. "QB J. Herbert". Left in place, that breaks the
// first-initial abbreviation check below (it no longer looks like
// "<initial> <lastname>"), so it's stripped before matching.
const POSITION_LABELS = new Set(["qb", "rb", "wr", "te", "k", "dst", "def", "flex"]);

function stripStrayPositionLabel(line) {
  const words = line.split(" ");
  if (words.length < 2) return line;
  if (POSITION_LABELS.has(words[0].toLowerCase())) return words.slice(1).join(" ").trim();
  if (POSITION_LABELS.has(words[words.length - 1].toLowerCase())) return words.slice(0, -1).join(" ").trim();
  return line;
}

function extractCandidateLines(ocrText) {
  const seen = new Set();
  const lines = [];
  for (const raw of ocrText.split(/\n+/)) {
    let line = raw.replace(/[^a-zA-Z.'\- ]/g, " ").replace(/\s+/g, " ").trim();
    line = stripStrayPositionLabel(line);
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
