// ── Sleeper player list, cached in the browser ───────────────────────
// Sleeper asks integrators not to hit /players/nfl more than once a
// day since it rarely changes and the raw payload is several MB. We
// fetch it once, strip it down to the fields we need, and cache the
// slim result in localStorage.

const PLAYERS_CACHE_KEY = "ffPlayersDbV2";
const PLAYERS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const FANTASY_POSITIONS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function readPlayersCache() {
  try {
    const raw = localStorage.getItem(PLAYERS_CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.players)) return null;
    if (Date.now() - parsed.ts > PLAYERS_CACHE_TTL_MS) return null;
    return parsed.players;
  } catch {
    return null;
  }
}

function writePlayersCache(players) {
  try {
    localStorage.setItem(PLAYERS_CACHE_KEY, JSON.stringify({ ts: Date.now(), players }));
  } catch (err) {
    console.warn("Could not cache Sleeper player list:", err);
  }
}

function slimPlayer(id, p) {
  const pos = p.position || (p.fantasy_positions && p.fantasy_positions[0]);
  if (!FANTASY_POSITIONS.has(pos)) return null;
  if (p.active === false) return null;
  const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ") || null;
  if (!name) return null;
  return {
    id,
    name,
    pos,
    team: p.team || null,
    norm: normalize(name),
    firstNorm: normalize(p.first_name || name.split(" ")[0]),
    lastNorm: normalize(p.last_name || name.split(" ").slice(-1)[0]),
  };
}

async function fetchPlayersDb() {
  const res = await fetch("https://api.sleeper.app/v1/players/nfl");
  if (!res.ok) throw new Error(`Sleeper player list fetch failed: ${res.status}`);
  const raw = await res.json();
  const players = [];
  for (const id of Object.keys(raw)) {
    const slim = slimPlayer(id, raw[id]);
    if (slim) players.push(slim);
  }
  writePlayersCache(players);
  return players;
}

async function getPlayersDb({ force = false } = {}) {
  if (!force) {
    const cached = readPlayersCache();
    if (cached) return cached;
  }
  return fetchPlayersDb();
}
