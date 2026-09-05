// ── "Set rosters from a photo" panel ─────────────────────────────────
// Runs OCR on a single uploaded matchup screenshot (client-side, via
// Tesseract.js — nothing is uploaded anywhere) showing both rosters
// side by side — your team on the left, your opponent's on the right.
// Each detected line is bucketed to a side by its horizontal position
// in the photo, then fuzzy-matched against Sleeper's player list, and
// the user confirms/fixes matches before saving. The resulting roster
// is encoded into the page URL (#roster=...) so it can be shared with
// a link, and mirrored into localStorage so it survives a reload on
// this browser.

(function () {
  const OVERRIDE_STORAGE_KEY = "ffMatchupOverrideV1";

  const teamState = {
    A: { candidates: [], manual: [] },
    B: { candidates: [], manual: [] },
  };

  let playersDbPromise = null;
  function ensurePlayersDb() {
    if (!playersDbPromise) playersDbPromise = getPlayersDb();
    return playersDbPromise;
  }

  function qs(sel, root) {
    return (root || document).querySelector(sel);
  }
  function qsa(sel, root) {
    return Array.from((root || document).querySelectorAll(sel));
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
      // (bbox.y0) — used below to guess the team name from whatever
      // text sits nearest the top of the screenshot.
      const { data } = await worker.recognize(file, {}, { blocks: true });
      return data;
    } finally {
      worker.terminate();
    }
  }

  // Flattens Tesseract's block/paragraph/line hierarchy into a flat
  // list of { text, x0, x1, y0 } so lines can be sorted/bucketed by
  // position on the photo.
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
          });
        }
      }
    }
    return lines;
  }

  // A matchup screenshot has your team on the left and your opponent's
  // on the right. Buckets each line by whether its horizontal center
  // falls left or right of the photo's midpoint.
  function splitLinesBySide(lines, midX) {
    const left = [];
    const right = [];
    for (const line of lines) {
      const center = (line.x0 + line.x1) / 2;
      (center < midX ? left : right).push(line);
    }
    return { left, right };
  }

  // Screenshots from Sleeper/ESPN/Yahoo etc. usually show the team name
  // near the top of each side of the roster view. Drops lines that are
  // just a status-bar clock or too short to be a name, and returns
  // whichever real line sits highest on that side of the image.
  function guessTeamNameFromLines(lines) {
    const candidates = lines
      .filter((l) => l.text.length >= 3 && l.text.length <= 40)
      .filter((l) => /[a-zA-Z]{2,}/.test(l.text)) // must have a real word, not just a clock/icon
      .filter((l) => !/^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(l.text)) // status-bar clock
      .sort((a, b) => a.y0 - b.y0);
    return candidates.length ? candidates[0].text : null;
  }

  // Loads a File just far enough to read its pixel dimensions, so line
  // positions (in pixels) can be compared against the photo's midpoint.
  function getImageWidth(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img.naturalWidth);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error("Could not read photo dimensions"));
      };
      img.src = url;
    });
  }

  function candidateRowHtml(candidate, idx) {
    const options = candidate.matches
      .map(
        (m, i) =>
          `<option value="${m.player.id}" ${i === 0 ? "selected" : ""}>${m.player.name} — ${m.player.pos}${
            m.player.team ? " " + m.player.team : ""
          } (${Math.round(m.score * 100)}%)</option>`
      )
      .join("");
    return `
      <div class="candidate-row" data-idx="${idx}">
        <div class="candidate-line">"${candidate.line}"</div>
        <select class="candidate-select">
          ${options}
          <option value="">Ignore this line</option>
        </select>
      </div>
    `;
  }

  function candidatesForSide(sideLines, playersDb) {
    const lines = extractCandidateLines(sideLines.map((l) => l.text).join("\n"));
    return lines.map((line) => ({ line, matches: matchLine(line, playersDb, 4) })).filter((c) => c.matches.length > 0);
  }

  async function handleMatchupPhoto(file, statusEl) {
    const teamAContainer = qs('.import-team[data-team="A"]');
    const teamBContainer = qs('.import-team[data-team="B"]');
    const listElA = qs(".candidate-list", teamAContainer);
    const listElB = qs(".candidate-list", teamBContainer);
    const nameInputA = qs(".team-name-input", teamAContainer);
    const nameInputB = qs(".team-name-input", teamBContainer);

    listElA.innerHTML = "";
    listElB.innerHTML = "";
    statusEl.textContent = "Loading player list…";
    const playersDb = await ensurePlayersDb();

    statusEl.textContent = "Reading photo… 0%";
    const [ocrData, imageWidth] = await Promise.all([
      ocrImage(file, (pct) => {
        statusEl.textContent = `Reading photo… ${pct}%`;
      }),
      getImageWidth(file),
    ]);

    const lines = flattenOcrLines(ocrData);
    const { left, right } = splitLinesBySide(lines, imageWidth / 2);

    const nameGuessA = guessTeamNameFromLines(left);
    const nameGuessB = guessTeamNameFromLines(right);
    if (nameGuessA) nameInputA.value = nameGuessA;
    if (nameGuessB) nameInputB.value = nameGuessB;

    const candidatesA = candidatesForSide(left, playersDb);
    const candidatesB = candidatesForSide(right, playersDb);
    teamState.A.candidates = candidatesA;
    teamState.B.candidates = candidatesB;
    listElA.innerHTML = candidatesA.map(candidateRowHtml).join("");
    listElB.innerHTML = candidatesB.map(candidateRowHtml).join("");

    const total = candidatesA.length + candidatesB.length;
    if (!total) {
      statusEl.textContent =
        "Couldn't confidently match any names in that photo. Try a clearer, less cropped screenshot, or add players manually below.";
      return;
    }
    statusEl.textContent = `Found ${candidatesA.length} on the left, ${candidatesB.length} on the right — double check them below, then click "Use these rosters".`;
  }

  function renderManualList(teamKey, container) {
    const el = qs(".manual-added", container);
    el.innerHTML = teamState[teamKey].manual
      .map(
        (p, i) =>
          `<span class="manual-chip">${p.name} (${p.pos})<button type="button" data-i="${i}" class="chip-remove" aria-label="Remove">×</button></span>`
      )
      .join("");
  }

  function setupManualSearch(teamKey, container) {
    const input = qs(".manual-search", container);
    const resultsEl = qs(".manual-results", container);
    let debounceTimer;

    input.addEventListener("input", () => {
      clearTimeout(debounceTimer);
      const q = input.value.trim();
      if (q.length < 2) {
        resultsEl.innerHTML = "";
        return;
      }
      debounceTimer = setTimeout(async () => {
        const playersDb = await ensurePlayersDb();
        const matches = matchLine(q, playersDb, 6);
        resultsEl.innerHTML =
          matches
            .map(
              (m) =>
                `<div class="manual-result" data-id="${m.player.id}">${m.player.name} — ${m.player.pos}${
                  m.player.team ? " " + m.player.team : ""
                }</div>`
            )
            .join("") || `<div class="manual-result empty">No matches</div>`;
      }, 200);
    });

    resultsEl.addEventListener("click", async (e) => {
      const row = e.target.closest(".manual-result[data-id]");
      if (!row) return;
      const db = await ensurePlayersDb();
      const player = db.find((p) => p.id === row.dataset.id);
      if (!player) return;
      teamState[teamKey].manual.push(player);
      renderManualList(teamKey, container);
      input.value = "";
      resultsEl.innerHTML = "";
    });
  }

  function initTeamPanel(teamKey) {
    const container = qs(`.import-team[data-team="${teamKey}"]`);

    setupManualSearch(teamKey, container);

    container.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip-remove");
      if (!btn) return;
      teamState[teamKey].manual.splice(Number(btn.dataset.i), 1);
      renderManualList(teamKey, container);
    });
  }

  function initMatchupPhotoInput() {
    const fileInput = qs("#matchup-photo-input");
    const statusEl = qs("#matchup-scan-status");

    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      handleMatchupPhoto(file, statusEl).catch((err) => {
        console.error(err);
        statusEl.textContent = "Something went wrong reading that photo — try again, or add players manually below.";
      });
    });
  }

  function collectTeamPlayers(teamKey, container) {
    const players = [];
    qsa(".candidate-select", container).forEach((sel) => {
      if (!sel.value) return;
      const idx = Number(sel.closest(".candidate-row").dataset.idx);
      const match = teamState[teamKey].candidates[idx].matches.find((m) => m.player.id === sel.value);
      if (match) players.push(match.player);
    });
    teamState[teamKey].manual.forEach((p) => players.push(p));
    return players;
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

  function init() {
    initTeamPanel("A");
    initTeamPanel("B");
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

    qs("#apply-roster").addEventListener("click", () => {
      const teamAContainer = qs('.import-team[data-team="A"]');
      const teamBContainer = qs('.import-team[data-team="B"]');
      const base = window.__ffOverride || DEFAULT_MATCHUP;

      const teamAPlayers = collectTeamPlayers("A", teamAContainer);
      const teamBPlayers = collectTeamPlayers("B", teamBContainer);

      const matchup = {
        season: base.season,
        week: base.week,
        teamA: {
          name: qs(".team-name-input", teamAContainer).value.trim() || base.teamA.name,
          players: teamAPlayers.length ? teamAPlayers.map(toMatchupPlayer) : base.teamA.players,
        },
        teamB: {
          name: qs(".team-name-input", teamBContainer).value.trim() || base.teamB.name,
          players: teamBPlayers.length ? teamBPlayers.map(toMatchupPlayer) : base.teamB.players,
        },
      };

      applyOverride(matchup);

      const shareInput = qs("#share-link-input");
      shareInput.value = buildShareUrl(matchup);
      qs("#share-link-box").hidden = false;
    });

    qs("#reset-roster").addEventListener("click", () => {
      window.__ffOverride = null;
      try {
        localStorage.removeItem(OVERRIDE_STORAGE_KEY);
      } catch {}
      history.replaceState(null, "", window.location.pathname + window.location.search);
      if (typeof window.ffRefreshMatchup === "function") window.ffRefreshMatchup();
      qs("#share-link-box").hidden = true;
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
