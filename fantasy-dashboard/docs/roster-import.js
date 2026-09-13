// ── "Set rosters from a photo" panel ─────────────────────────────────
// Runs OCR on one or more uploaded matchup screenshots (client-side, via
// Tesseract.js — nothing is uploaded anywhere) showing both rosters
// side by side — your team on the left, your opponent's on the right.
// A roster too long for one screen can be split across several shots;
// their rows are merged with duplicates dropped.
// Each detected line is bucketed to a side by its horizontal position
// in the photo, fuzzy-matched against Sleeper's player list, and the
// two sides are paired into rows by height on the photo (each row
// flagged starter or bench from its center badge). The roster is
// applied automatically from the best match — no manual
// confirmation step. The result is encoded into the page URL
// (#roster=...) so it can be shared with a link, and mirrored into
// localStorage so it survives a reload on this browser.

(function () {
  const OVERRIDE_STORAGE_KEY = "ffMatchupOverrideV1";

  let playersDbPromise = null;
  function ensurePlayersDb() {
    if (!playersDbPromise) playersDbPromise = getPlayersDb();
    return playersDbPromise;
  }

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }

  async function ocrImage(file, onProgress) {
    const worker = await Tesseract.createWorker("eng", 1, {
      logger: (m) => {
        if (m.status === "recognizing text" && onProgress) {
          onProgress(Math.round((m.progress || 0) * 100));
        }
      },
    });
    try {
      // `blocks: true` also gets us each line's position on the image
      // (bbox.x0/x1/y0) — used below to split the photo into a left
      // and right roster, and to guess each side's team name.
      const { data } = await worker.recognize(file, {}, { blocks: true });
      return data;
    } finally {
      worker.terminate();
    }
  }

  // Flattens Tesseract's block/paragraph/line hierarchy into a flat
  // list of { text, x0, x1, y0, words } so lines can be sorted/bucketed
  // by position on the photo. Word-level bboxes are kept because a
  // matchup screenshot's two team headers (or two same-row players)
  // often sit on the same text baseline — Tesseract reads that as one
  // "line" spanning both columns, so splitting on the line's own bbox
  // would put the whole row on one side. Splitting its words instead
  // and rejoining each side's words back into text avoids that.
  function flattenOcrLines(ocrData) {
    const lines = [];
    for (const block of ocrData.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          lines.push({
            text: (line.text || "").trim(),
            x0: line.bbox.x0,
            x1: line.bbox.x1,
            y0: line.bbox.y0,
            y1: line.bbox.y1,
            words: (line.words || []).map((w) => ({
              text: (w.text || "").trim(),
              x0: w.bbox.x0,
              x1: w.bbox.x1,
            })),
          });
        }
      }
    }
    return lines;
  }

  // A matchup screenshot has your team on the left and your opponent's
  // on the right. Splits each OCR line's words by whether their
  // horizontal center falls left or right of the photo's midpoint, and
  // rejoins each side's words (in their original order) into that
  // side's version of the line.
  function splitLinesBySide(lines, midX) {
    const left = [];
    const right = [];
    for (const line of lines) {
      const leftWords = [];
      const rightWords = [];
      for (const w of line.words) {
        const center = (w.x0 + w.x1) / 2;
        (center < midX ? leftWords : rightWords).push(w.text);
      }
      if (leftWords.length) left.push({ text: leftWords.join(" "), y0: line.y0, y1: line.y1 });
      if (rightWords.length) right.push({ text: rightWords.join(" "), y0: line.y0, y1: line.y1 });
    }
    return { left, right };
  }

  // The big projected-score number ("89.42") sits directly under the
  // team name with nothing in between, on both Sleeper- and
  // Yahoo-style layouts — a much closer, more reliable anchor than the
  // roster itself: a full, uncropped screenshot stacks a whole stack of
  // other real text between the team name and the first player row
  // (the live score, "Projected"/win% labels, a week selector) that
  // would otherwise win a "closest line above the roster" search.
  // A real OCR'd score line is rarely a clean, isolated "89.42" — it's
  // often stuck to stray noise from a nearby icon or the "/" divider,
  // so this only requires the pattern to appear _somewhere_ in the
  // line rather than requiring an exact whole-line match.
  function isBigScoreLine(rawText) {
    return /\d{1,3}\.\d{1,2}/.test(rawText.trim());
  }

  function findScoreLineY0(sideLines) {
    const hit = sideLines.find((l) => isBigScoreLine(l.text));
    return hit ? hit.y0 : null;
  }

  // Stock UI text that every fantasy app's matchup screen carries near
  // the roster — a week selector, "Projected"/win% labels, a scoring
  // log link — and that OCR reads just as cleanly as a real team name.
  // Recognizing it by content, not just position, is what keeps it out
  // even when the positional anchors below miss (e.g. a noisy photo
  // where the score line doesn't parse and the search falls back to
  // "closest line above the roster", which these rows sit closest to).
  const UI_CHROME_PATTERNS = [
    /\bweek\b/i,
    /\bmatchup/i,
    /scoring\s*log/i,
    /\bprojected\b/i,
    /\bwin\s*%/i,
    // The app's tab bar ("Team  Matchup  Players  League"), which is
    // all a scrolled-down screenshot has above its first player row.
    /^(team|players|league|\s)+$/i,
  ];

  function looksLikeUiChrome(text) {
    return UI_CHROME_PATTERNS.some((re) => re.test(text));
  }

  // The team name sits directly above where that side's roster starts
  // — but "directly above" is relative to the roster, not to the top
  // of the photo. A full, uncropped screenshot (phone status bar, nav
  // title, tab bar) stacks real header text above the team name too,
  // so "whichever real line sits highest on the page" — which worked
  // for a tightly-cropped roster view — grabs that header instead once
  // there's more page above the matchup. Anchoring to `beforeY0`
  // (preferably the big score line, falling back to the first player
  // this side actually matched) fixes that: the search only looks
  // above that anchor, and prefers the closest line to it.
  // beforeY0 == null (neither anchor found) falls back to topmost.
  function pickTeamNameLine(sideLines, beforeY0) {
    const candidates = sideLines
      .filter((l) => !looksLikeTagLine(l.text))
      .map((l) => ({ text: cleanLineText(l.text), y0: l.y0 }))
      .filter((l) => l.text.length >= 3 && l.text.length <= 40)
      .filter((l) => /[a-zA-Z]{2,}/.test(l.text)) // must have a real word, not just a clock/icon
      // A team's small logo/avatar sits right at the score's height, not
      // the name's, but a garbled OCR read of it (e.g. ". Mm") is still
      // short enough to slip past the length check above — a real team
      // name has more actual letters in it than that.
      .filter((l) => (l.text.match(/[a-zA-Z]/g) || []).length >= 3)
      .filter((l) => !/^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(l.text)) // status-bar clock
      .filter((l) => !isTeamTagLine(l.text))
      .filter((l) => !looksLikeUiChrome(l.text));
    if (!candidates.length) return null;

    const above = beforeY0 != null ? candidates.filter((l) => l.y0 < beforeY0) : [];
    if (above.length) {
      above.sort((a, b) => b.y0 - a.y0); // closest line above the roster
      return above[0];
    }
    const sorted = [...candidates].sort((a, b) => a.y0 - b.y0);
    return sorted[0]; // fallback: topmost real line on this side
  }

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read that photo"));
      };
      img.src = url;
    });
  }

  // OCR accuracy on small text (a phone screenshot with two full
  // rosters crammed side by side) drops off fast below a certain pixel
  // width — small text reads noisier, more characters get misread, and
  // more real players end up below the match-confidence bar below.
  // Upscaling a small photo onto a canvas before handing it to
  // Tesseract is a standard fix for that; a photo already wider than
  // this keeps its size. It's drawn onto a canvas either way so its
  // pixels can be read back too (see isBenchRow).
  const MIN_OCR_WIDTH = 1600;

  async function prepareImageForOcr(file) {
    const img = await loadImage(file);
    const scale = Math.max(1, MIN_OCR_WIDTH / img.naturalWidth);
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    return { canvas, width };
  }

  // A bench row's center column holds a solid dark-gray "BN" badge,
  // where a starter's badge is a pale pill with colored text ("QB",
  // "WRT", "DEF"…). OCR can't be trusted to read "BN" (white on dark
  // comes out as "on |"), but the badge itself is easy to see: count
  // the dark, colorless pixels in a box at the center of the row, just
  // below the top of the name line. A starter's colored label text is
  // saturated, so it doesn't count toward that.
  const BENCH_BADGE_MIN_FRACTION = 0.3;

  function isBenchRow(canvas, y0, lineHeight) {
    const x = Math.round(canvas.width * 0.47);
    const w = Math.round(canvas.width * 0.06);
    const y = Math.round(y0 + lineHeight * 0.5);
    const h = Math.round(lineHeight * 2);
    if (w < 1 || h < 1 || y + h > canvas.height) return false;
    const { data } = canvas.getContext("2d", { willReadFrequently: true }).getImageData(x, y, w, h);
    let dark = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (lum < 140 && Math.max(r, g, b) - Math.min(r, g, b) < 45) dark++;
    }
    return dark / (data.length / 4) >= BENCH_BADGE_MIN_FRACTION;
  }

  // Matches each OCR'd line on one side against the player list and
  // keeps only the best match per line — the whole flow is automatic,
  // so there's no dropdown to pick between alternates. A matchup photo
  // packs in a lot of non-name text (team/position codes, game clocks,
  // scores) that inevitably ends up as a "candidate line" too; unlike
  // a real name, that text only ever scores weakly (well under 0.6 in
  // testing), so requiring high confidence here — well above
  // matchLine's own loose generation threshold — is what keeps that
  // noise out of the roster instead of being silently misapplied.
  const AUTO_ACCEPT_MIN_SCORE = 0.7;

  // Returns each match along with its line's y0 (rather than just the
  // player) so the caller can both find where the roster starts on the
  // page (for pickTeamNameLine) and exclude whichever line turns out to
  // be the team name from the final roster — a team name can otherwise
  // coincidentally fuzzy-match a real player or defense (e.g. a team
  // named "...Bears" matching the Chicago Bears D/ST).
  function playersForSide(sideLines, playersDb) {
    // Cleaned in original top-to-bottom order (not deduped/rejoined like
    // extractCandidateLines does) so a name line stays adjacent to its
    // own team-tag line below it — that adjacency is what lets a team
    // hint be attributed to the right player.
    const cleaned = sideLines.map((l) => ({ text: cleanLineText(l.text), y0: l.y0, y1: l.y1 }));
    const matched = [];
    for (let i = 0; i < cleaned.length; i++) {
      const { text: line, y0, y1 } = cleaned[i];
      if (!line || line.length < 3 || line.length > 40) continue;
      if (isTeamTagLine(line) || looksLikeTagLine(sideLines[i].text)) continue; // this line IS the context, not a name

      // A leftover team-abbreviation fragment (e.g. "LAC") is short
      // enough to land as a substring inside an unrelated player's
      // name (e.g. "Flacco") and still clear the score bar above — so
      // lines too short to plausibly be a real name are skipped before
      // matching at all, rather than trusted on score alone.
      if (normalize(line).length < 4) continue;

      let teamHint = null;
      for (let j = i + 1; j <= i + 2 && j < cleaned.length; j++) {
        teamHint = extractTeamAbbr(cleaned[j].text || "");
        if (teamHint) break;
      }

      const matches = matchLine(line, playersDb, 1, teamHint);
      let player = matches.length && matches[0].score >= AUTO_ACCEPT_MIN_SCORE ? matches[0].player : null;
      if (!player && teamHint) player = matchInitialOnTeam(line, teamHint, playersDb);
      if (player) {
        // `tagged`: this line is clearly a roster row — a team code sits
        // under it (a team name has a score under it instead) or the name
        // matched near-exactly. Such a line must never be taken for the
        // team name: the header's score can misread (e.g. "13.00" as
        // "1300"), moving the name search down to the first player row,
        // which then "wins" as the team name and drops that player.
        const strong = matches.length && matches[0].player === player && matches[0].score >= 0.9;
        matched.push({ player, y0, y1, tagged: !!teamHint || !!strong });
      }
    }
    return matched;
  }

  // Fallback for an "X. LASTNAME" line whose surname OCR mangled past
  // the fuzzy matcher's bar: the team code read under it narrows the
  // field to one NFL roster, where the initial plus a loose surname
  // match is enough to be sure. Also covers the period being dropped so
  // the initial is glued on ("JLOVED)" for "J. LOVE" + injury badge) —
  // there the surname has to be a clean prefix, since there's no word
  // boundary to trust.
  function matchInitialOnTeam(line, team, playersDb) {
    const words = normalize(line).split(" ");
    if (!words[0]) return null;
    const spaced = words.length >= 2 && words[0].length === 1;
    const initial = words[0][0];
    const rest = spaced ? words.slice(1).join("") : words.join("").slice(1);
    if (rest.length < 3) return null;
    let best = null;
    for (const p of playersDb) {
      if (p.team !== team || !p.firstNorm.startsWith(initial) || !p.lastNorm) continue;
      const last = p.lastNorm.replace(/ /g, "");
      const sim = spaced ? (rest.startsWith(last) ? 1 : similarity(rest, last)) : last.length >= 4 && rest.startsWith(last) ? 1 : 0;
      if (sim >= 0.7 && (!best || sim > best.sim)) best = { p, sim };
    }
    return best ? best.p : null;
  }

  // Lines up the two sides' matched players into matchup rows by height
  // on the photo — each row's left and right player share a baseline —
  // so a name missed on one side leaves a gap in that row instead of
  // shifting every player below it into the wrong row.
  function pairRows(matchedA, matchedB) {
    const rows = matchedA.map((m) => ({ a: m, b: null }));
    for (const m of matchedB) {
      let best = null;
      for (const row of rows) {
        if (row.b) continue;
        const tolerance = 1.5 * Math.max(m.y1 - m.y0, row.a.y1 - row.a.y0);
        const dist = Math.abs(row.a.y0 - m.y0);
        if (dist <= tolerance && (!best || dist < best.dist)) best = { row, dist };
      }
      if (best) best.row.b = m;
      else rows.push({ a: null, b: m });
    }
    return rows
      .map((row) => {
        const sides = [row.a, row.b].filter(Boolean);
        return {
          a: row.a && row.a.player,
          b: row.b && row.b.player,
          y0: Math.min(...sides.map((s) => s.y0)),
          lineHeight: Math.max(...sides.map((s) => s.y1 - s.y0)),
        };
      })
      .sort((r1, r2) => r1.y0 - r2.y0);
  }

  // A roster slot is null when that side of a row couldn't be read, so
  // both teams' arrays stay aligned row for row (see app.js).
  function toMatchupPlayer(p, bench) {
    if (!p) return null;
    const slot = { name: p.name, sleeper_id: p.id, pos: p.pos, team: p.team };
    if (bench) slot.bench = true;
    return slot;
  }

  function encodeRoster(matchup) {
    return btoa(unescape(encodeURIComponent(JSON.stringify(matchup))));
  }

  function buildShareUrl(matchup) {
    const url = new URL(window.location.href);
    url.hash = "roster=" + encodeRoster(matchup);
    return url.toString();
  }

  function applyOverride(matchup) {
    window.__ffOverride = matchup;
    try {
      localStorage.setItem(OVERRIDE_STORAGE_KEY, JSON.stringify(matchup));
    } catch {}
    history.replaceState(null, "", "#roster=" + encodeRoster(matchup));
    if (typeof window.ffRefreshMatchup === "function") window.ffRefreshMatchup();

    // When cloud sync is set up, this pushes the roster to every open
    // tab automatically (see sync.js) — the copied link below still
    // works too, as a manual fallback or for a device that hasn't
    // opened the page yet.
    if (isCloudSyncEnabled()) {
      saveMatchupToCloud(matchup).catch((err) => {
        console.warn("Could not save roster to cloud (non-fatal):", err.message);
      });
    }
  }

  function playerLineHtml(p) {
    if (!p) return `<li class="missing">— not read —</li>`;
    return `<li>${p.name} — ${p.bench ? "BN · " : ""}${p.pos}${p.team ? " " + p.team : ""}</li>`;
  }

  function renderDetected(matchup) {
    const el = qs("#detected-rosters");
    qs("#detected-name-a", el).textContent = matchup.teamA.name;
    qs("#detected-name-b", el).textContent = matchup.teamB.name;
    qs("#detected-players-a", el).innerHTML = matchup.teamA.players.map(playerLineHtml).join("");
    qs("#detected-players-b", el).innerHTML = matchup.teamB.players.map(playerLineHtml).join("");
    el.hidden = false;
  }

  // Reads one photo into matchup rows plus each side's team-name guess.
  function readPhoto(canvas, ocrData, playersDb) {
    const lines = flattenOcrLines(ocrData);
    const { left, right } = splitLinesBySide(lines, canvas.width / 2);
    const sideA = readSide(left, playersDb);
    const sideB = readSide(right, playersDb);
    const rows = pairRows(sideA.matched, sideB.matched);
    for (const row of rows) row.bench = isBenchRow(canvas, row.y0, row.lineHeight);
    return { rows, nameA: sideA.name, nameB: sideB.name };
  }

  function readSide(sideLines, playersDb) {
    const matched = playersForSide(sideLines, playersDb);
    const scoreY0 = findScoreLineY0(sideLines);
    const firstY0 = matched.length ? Math.min(...matched.map((m) => m.y0)) : null;
    // A line confirmed as a player by its team code can't be the team name.
    const taggedY0s = new Set(matched.filter((m) => m.tagged).map((m) => m.y0));
    const nameLine = pickTeamNameLine(
      sideLines.filter((l) => !taggedY0s.has(l.y0)),
      scoreY0 ?? firstY0
    );
    // An unconfirmed match on the line claimed as the team name is
    // likely the team name fuzzy-matching a player (a team named
    // "...Bears" vs the Chicago Bears D/ST) — drop it from the roster.
    const kept = matched.filter((m) => m.tagged || !nameLine || m.y0 !== nameLine.y0);
    return {
      matched: kept,
      // `anchored`: the name sits above the big score, i.e. this photo
      // shows the real matchup header rather than a guess.
      name: nameLine ? { text: nameLine.text, anchored: scoreY0 != null && nameLine.y0 < scoreY0 } : null,
    };
  }

  // Merges rows across photos. Consecutive screenshots of a long roster
  // overlap by a row or two, so a row whose player was already seen is
  // merged into the existing row (filling a side one photo missed)
  // rather than listed twice. Starters come first, then the bench, no
  // matter which order the photos were picked in.
  function mergeRows(photos) {
    // The photo showing the matchup header is the top of the roster, so
    // it goes first even if it wasn't picked first.
    const showsHeader = (p) => !!((p.nameA && p.nameA.anchored) || (p.nameB && p.nameB.anchored));
    photos = [...photos].sort((p, q) => showsHeader(q) - showsHeader(p));
    const rows = [];
    const has = (p) => p && rows.some((r) => (r.a && r.a.id === p.id) || (r.b && r.b.id === p.id));
    const rowWith = (p) => p && rows.find((r) => (r.a && r.a.id === p.id) || (r.b && r.b.id === p.id));
    for (const photo of photos) {
      for (const row of photo.rows) {
        const existing = rowWith(row.a) || rowWith(row.b);
        if (!existing) {
          rows.push({ a: row.a, b: row.b, bench: row.bench });
          continue;
        }
        if (!existing.a && row.a && !has(row.a)) existing.a = row.a;
        if (!existing.b && row.b && !has(row.b)) existing.b = row.b;
        existing.bench = existing.bench || row.bench;
      }
    }
    return [...rows.filter((r) => !r.bench), ...rows.filter((r) => r.bench)];
  }

  function pickName(names) {
    const found = names.filter(Boolean);
    const best = found.find((n) => n.anchored) || found[0];
    return best ? best.text : null;
  }

  async function handleMatchupPhotos(files, statusEl) {
    qs("#detected-rosters").hidden = true;
    statusEl.textContent = "Loading player list…";
    const playersDb = await ensurePlayersDb();

    const photos = [];
    for (let i = 0; i < files.length; i++) {
      const label = files.length > 1 ? `Reading photo ${i + 1} of ${files.length}…` : "Reading photo…";
      const { canvas } = await prepareImageForOcr(files[i]);

      statusEl.textContent = `${label} 0%`;
      const ocrData = await ocrImage(canvas, (pct) => {
        statusEl.textContent = `${label} ${pct}%`;
      });
      photos.push(readPhoto(canvas, ocrData, playersDb));
    }

    const rows = mergeRows(photos);
    const countA = rows.filter((r) => r.a).length;
    const countB = rows.filter((r) => r.b).length;

    if (!countA && !countB) {
      const which = files.length > 1 ? "those photos" : "that photo";
      statusEl.textContent = `Couldn't confidently match any names in ${which} — try a clearer, less cropped screenshot.`;
      return;
    }

    const base = window.__ffOverride || DEFAULT_MATCHUP;
    const matchup = {
      season: base.season,
      week: base.week,
      teamA: {
        name: pickName(photos.map((p) => p.nameA)) || base.teamA.name,
        players: rows.map((r) => toMatchupPlayer(r.a, r.bench)),
      },
      teamB: {
        name: pickName(photos.map((p) => p.nameB)) || base.teamB.name,
        players: rows.map((r) => toMatchupPlayer(r.b, r.bench)),
      },
    };

    applyOverride(matchup);
    renderDetected(matchup);

    const shareInput = qs("#share-link-input");
    shareInput.value = buildShareUrl(matchup);
    qs("#share-link-box").hidden = false;

    const benchCount = rows.filter((r) => r.bench).length;
    statusEl.textContent =
      `Applied — found ${countA} on the left, ${countB} on the right ` +
      `(${rows.length - benchCount} starter rows, ${benchCount} bench).`;
  }

  function initMatchupPhotoInput() {
    const fileInput = qs("#matchup-photo-input");
    const statusEl = qs("#matchup-scan-status");

    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files);
      if (!files.length) return;
      handleMatchupPhotos(files, statusEl)
        .catch((err) => {
          console.error(err);
          statusEl.textContent = "Something went wrong reading that photo — try again with a clearer screenshot.";
        })
        .finally(() => {
          // Lets the same photo(s) be picked again and still fire "change".
          fileInput.value = "";
        });
    });
  }

  function init() {
    initMatchupPhotoInput();

    const syncStatusEl = qs("#sync-status");
    const shareLinkLabel = qs("#share-link-label");
    if (isCloudSyncEnabled()) {
      syncStatusEl.textContent = "☁️ Cloud sync is on — saving here updates your friend's page automatically.";
      shareLinkLabel.textContent = "Backup link (in case their page hasn't loaded yet)";
    } else {
      syncStatusEl.textContent = "";
      shareLinkLabel.textContent = "Shareable link — send this to your friend";
    }

    qs("#reset-roster").addEventListener("click", () => {
      window.__ffOverride = null;
      try {
        localStorage.removeItem(OVERRIDE_STORAGE_KEY);
      } catch {}
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (typeof window.ffRefreshMatchup === "function") window.ffRefreshMatchup();
      qs("#share-link-box").hidden = true;
      qs("#detected-rosters").hidden = true;
    });

    qs("#copy-link-btn").addEventListener("click", async () => {
      const input = qs("#share-link-input");
      input.select();
      const btn = qs("#copy-link-btn");
      try {
        await navigator.clipboard.writeText(input.value);
      } catch {
        document.execCommand("copy");
      }
      const original = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
