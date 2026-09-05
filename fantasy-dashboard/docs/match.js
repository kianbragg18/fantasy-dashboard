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
  //
  // The last name itself is matched with a little edit-distance
  // tolerance rather than requiring an exact string match — a real
  // photo (screen glare, compression, a small font) reliably OCRs a
  // single bold initial correctly but can drop a character in a
  // longer surname, and an exact-match requirement there would reject
  // the correct player outright instead of just scoring it lower.
  if (player.lastNorm) {
    const lastWords = player.lastNorm.split(" ");
    const normWords = norm.split(" ");
    // The last name can appear anywhere in the line, not just at the
    // very end — a row's status text ("4th 3:38 21-27 @ LAR") can leak
    // in as trailing noise after the real name — so every possible
    // window of the right length is checked for the closest fuzzy
    // match to the player's last name, rather than assuming the last
    // `lastWords.length` words are it.
    let best = null;
    for (let i = 0; i + lastWords.length <= normWords.length; i++) {
      if (i === 0 && normWords.length === lastWords.length) continue; // no room for a first name/initial
      const window = normWords.slice(i, i + lastWords.length).join(" ");
      const sim = window === player.lastNorm ? 1 : similarity(window, player.lastNorm);
      if (!best || sim > best.sim) best = { index: i, sim };
    }
    if (best && (best.sim === 1 || (player.lastNorm.length >= 4 && best.sim >= 0.85))) {
      // Only the word right before the last name has to match — a
      // matchup screen's position label sits close to the name and can
      // partially survive OCR as a stray leading word (e.g. a blurred
      // "QB" read as just "B", leaving "b j herbert"); that shouldn't
      // sink an otherwise-correct match.
      const closestWord = normWords[best.index - 1];
      if (closestWord && player.firstNorm && (closestWord === player.firstNorm || player.firstNorm.startsWith(closestWord))) {
        // A longer last name is stronger, more specific evidence than a
        // short one — without this, a query like "J Smith Njigba" ties
        // "Jaxon Smith-Njigba" (2-word last name, matched in full) with
        // every unrelated "J* Smith" player (1-word last name, matched
        // against only part of the query), and the tie gets broken by
        // arbitrary array order instead of by which match is actually
        // more complete.
        const lengthBonus = 0.03 * (lastWords.length - 1);
        return Math.min(0.99, 0.9 * best.sim + 0.03 + lengthBonus);
      }
      return 0; // shares a last name, but the first name/initial doesn't match
    }
  }

  return similarity(norm, player.norm);
}

// teamHint, when given, is a team abbreviation read from the line next
// to this one (see extractTeamAbbr) — it can't override a strong name
// match, but it's decisive when two candidates are otherwise tied.
function matchLine(lineText, playersDb, topN = 3, teamHint = null) {
  const norm = normalize(lineText);
  if (norm.length < 3) return [];
  const scored = playersDb
    .map((p) => {
      let score = scorePlayer(norm, p);
      if (teamHint && p.team) {
        score = p.team === teamHint ? Math.min(0.99, score + 0.08) : score * 0.5;
      }
      return { player: p, score };
    })
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

function cleanLineText(raw) {
  const line = raw.replace(/[^a-zA-Z.'\- ]/g, " ").replace(/\s+/g, " ").trim();
  return stripStrayPositionLabel(line);
}

function extractCandidateLines(ocrText) {
  const seen = new Set();
  const lines = [];
  for (const raw of ocrText.split(/\n+/)) {
    const line = cleanLineText(raw);
    if (line.length < 3 || line.length > 40) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return lines;
}

// A matchup screen prints each player's team under (or beside) their
// name — e.g. "PHI" under Saquon Barkley — which is the one piece of
// context OCR can actually read that a name alone can't give: two
// unrelated players sharing an initial and last name (DJ Moore, WR
// BUF vs. David Moore, WR CAR) score identically on name text alone.
const TEAM_ABBRS = new Set([
  "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
  "DET", "GB", "HOU", "IND", "JAX", "KC", "LAC", "LAR", "LV", "MIA",
  "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB",
  "TEN", "WAS",
]);

function extractTeamAbbr(rawLine) {
  const words = cleanLineText(rawLine).toUpperCase().split(" ").filter(Boolean);
  for (const w of words) {
    if (TEAM_ABBRS.has(w)) return w;
  }
  return null;
}

// A line that's just a team code (plus maybe a position label, e.g.
// "WR PHI") is context for the name line next to it, not a name
// candidate in its own right — matching it against the player list
// would just add noise.
function isTeamTagLine(cleanedLine) {
  if (!extractTeamAbbr(cleanedLine)) return false;
  return cleanedLine.split(" ").filter(Boolean).length <= 2;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    normalize,
    levenshtein,
    similarity,
    matchLine,
    extractCandidateLines,
    cleanLineText,
    extractTeamAbbr,
    isTeamTagLine,
    TEAM_ABBRS,
  };
}
