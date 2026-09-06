// ── "Set rosters from a photo" panel ─────────────────────────────────
// Runs OCR on a single uploaded matchup screenshot (client-side, via
// Tesseract.js — nothing is uploaded anywhere) showing both rosters
// side by side — your team on the left, your opponent's on the right.
// Each detected line is bucketed to a side by its horizontal position
// in the photo, fuzzy-matched against Sleeper's player list, and the
// roster is applied automatically from the best match — no manual
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
      if (leftWords.length) left.push({ text: leftWords.join(" "), y0: line.y0 });
      if (rightWords.length) right.push({ text: rightWords.join(" "), y0: line.y0 });
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
  const UI_CHROME_PATTERNS = [/\bweek\b/i, /\bmatchup/i, /scoring\s*log/i, /\bprojected\b/i, /\bwin\s*%/i];

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
  // this is left alone.
  const MIN_OCR_WIDTH = 1600;

  async function prepareImageForOcr(file) {
    const img = await loadImage(file);
    if (img.naturalWidth >= MIN_OCR_WIDTH) {
      return { source: img, width: img.naturalWidth };
    }
    const scale = MIN_OCR_WIDTH / img.naturalWidth;
    const width = Math.round(img.naturalWidth * scale);
    const height = Math.round(img.naturalHeight * scale);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(img, 0, 0, width, height);
    return { source: canvas, width };
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
    const cleaned = sideLines.map((l) => ({ text: cleanLineText(l.text), y0: l.y0 }));
    const matched = [];
    for (let i = 0; i < cleaned.length; i++) {
      const { text: line, y0 } = cleaned[i];
      if (!line || line.length < 3 || line.length > 40) continue;
      if (isTeamTagLine(line)) continue; // this line IS the context, not a name

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
      if (matches.length && matches[0].score >= AUTO_ACCEPT_MIN_SCORE) {
        matched.push({ player: matches[0].player, y0 });
      }
    }
    return matched;
  }

  function toMatchupPlayer(p) {
    return { name: p.name, sleeper_id: p.id, pos: p.pos, team: p.team };
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
    return `<li>${p.name} — ${p.pos}${p.team ? " " + p.team : ""}</li>`;
  }

  function renderDetected(matchup) {
    const el = qs("#detected-rosters");
    qs("#detected-name-a", el).textContent = matchup.teamA.name;
    qs("#detected-name-b", el).textContent = matchup.teamB.name;
    qs("#detected-players-a", el).innerHTML = matchup.teamA.players.map(playerLineHtml).join("");
    qs("#detected-players-b", el).innerHTML = matchup.teamB.players.map(playerLineHtml).join("");
    el.hidden = false;
  }

  async function handleMatchupPhoto(file, statusEl) {
    qs("#detected-rosters").hidden = true;
    statusEl.textContent = "Loading player list…";
    const playersDb = await ensurePlayersDb();

    const { source, width: imageWidth } = await prepareImageForOcr(file);

    statusEl.textContent = "Reading photo… 0%";
    const ocrData = await ocrImage(source, (pct) => {
      statusEl.textContent = `Reading photo… ${pct}%`;
    });

    const lines = flattenOcrLines(ocrData);
    const { left, right } = splitLinesBySide(lines, imageWidth / 2);

    const matchedA = playersForSide(left, playersDb);
    const matchedB = playersForSide(right, playersDb);
    const firstY0A = matchedA.length ? Math.min(...matchedA.map((m) => m.y0)) : null;
    const firstY0B = matchedB.length ? Math.min(...matchedB.map((m) => m.y0)) : null;
    const boundaryA = findScoreLineY0(left) ?? firstY0A;
    const boundaryB = findScoreLineY0(right) ?? firstY0B;

    const nameLineA = pickTeamNameLine(left, boundaryA);
    const nameLineB = pickTeamNameLine(right, boundaryB);
    // A team name occasionally scores well enough against the player
    // list to slip into `matched` itself (see playersForSide) — drop it
    // from the roster now that it's been claimed as the team name.
    const playersA = matchedA.filter((m) => !nameLineA || m.y0 !== nameLineA.y0).map((m) => m.player);
    const playersB = matchedB.filter((m) => !nameLineB || m.y0 !== nameLineB.y0).map((m) => m.player);

    if (!playersA.length && !playersB.length) {
      statusEl.textContent = "Couldn't confidently match any names in that photo — try a clearer, less cropped screenshot.";
      return;
    }

    const base = window.__ffOverride || DEFAULT_MATCHUP;
    const matchup = {
      season: base.season,
      week: base.week,
      teamA: {
        name: (nameLineA && nameLineA.text) || base.teamA.name,
        players: playersA.length ? playersA.map(toMatchupPlayer) : base.teamA.players,
      },
      teamB: {
        name: (nameLineB && nameLineB.text) || base.teamB.name,
        players: playersB.length ? playersB.map(toMatchupPlayer) : base.teamB.players,
      },
    };

    applyOverride(matchup);
    renderDetected(matchup);

    const shareInput = qs("#share-link-input");
    shareInput.value = buildShareUrl(matchup);
    qs("#share-link-box").hidden = false;

    statusEl.textContent = `Applied — found ${playersA.length} on the left, ${playersB.length} on the right.`;
  }

  function initMatchupPhotoInput() {
    const fileInput = qs("#matchup-photo-input");
    const statusEl = qs("#matchup-scan-status");

    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      handleMatchupPhoto(file, statusEl).catch((err) => {
        console.error(err);
        statusEl.textContent = "Something went wrong reading that photo — try again with a clearer screenshot.";
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
