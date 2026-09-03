// ── "Set rosters from a photo" panel ─────────────────────────────────
// Runs OCR on an uploaded roster screenshot (client-side, via
// Tesseract.js — nothing is uploaded anywhere), fuzzy-matches each
// detected line against Sleeper's player list, and lets the user
// confirm/fix matches before saving. The resulting roster is encoded
// into the page URL (#roster=...) so it can be shared with a link, and
// mirrored into localStorage so it survives a reload on this browser.

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

  // Screenshots from Sleeper/ESPN/Yahoo etc. usually show the team name
  // near the top of the roster view. Flattens every OCR'd line with its
  // vertical position, drops lines that are just a status-bar clock or
  // too short to be a name, and returns whichever real line sits
  // highest on the image.
  function guessTeamName(ocrData) {
    const lines = [];
    for (const block of ocrData.blocks || []) {
      for (const para of block.paragraphs || []) {
        for (const line of para.lines || []) {
          lines.push(line);
        }
      }
    }
    const candidates = lines
      .map((line) => ({ text: (line.text || "").trim(), y0: line.bbox.y0 }))
      .filter((l) => l.text.length >= 3 && l.text.length <= 40)
      .filter((l) => /[a-zA-Z]{2,}/.test(l.text)) // must have a real word, not just a clock/icon
      .filter((l) => !/^\d{1,2}:\d{2}\s?(AM|PM)?$/i.test(l.text)) // status-bar clock
      .sort((a, b) => a.y0 - b.y0);
    return candidates.length ? candidates[0].text : null;
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

  async function handlePhoto(teamKey, file, statusEl, listEl, nameInput) {
    listEl.innerHTML = "";
    statusEl.textContent = "Loading player list…";
    const playersDb = await ensurePlayersDb();

    statusEl.textContent = "Reading photo… 0%";
    const ocrData = await ocrImage(file, (pct) => {
      statusEl.textContent = `Reading photo… ${pct}%`;
    });

    const teamNameGuess = guessTeamName(ocrData);
    if (teamNameGuess && nameInput) {
      nameInput.value = teamNameGuess;
    }

    const lines = extractCandidateLines(ocrData.text || "");
    const candidates = lines
      .map((line) => ({ line, matches: matchLine(line, playersDb, 4) }))
      .filter((c) => c.matches.length > 0);

    teamState[teamKey].candidates = candidates;

    const nameNote = teamNameGuess
      ? ` Guessed team name "${teamNameGuess}" from the top of the photo — check it above.`
      : "";

    if (!candidates.length) {
      statusEl.textContent =
        "Couldn't confidently match any names in that photo. Try a clearer/closer screenshot, or add players manually below." +
        nameNote;
      return;
    }

    statusEl.textContent = `Found ${candidates.length} possible player${
      candidates.length === 1 ? "" : "s"
    } — double check them below, then click "Use these rosters".${nameNote}`;
    listEl.innerHTML = candidates.map(candidateRowHtml).join("");
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
    const fileInput = qs(".photo-input", container);
    const statusEl = qs(".scan-status", container);
    const listEl = qs(".candidate-list", container);
    const nameInput = qs(".team-name-input", container);

    fileInput.addEventListener("change", () => {
      const file = fileInput.files[0];
      if (!file) return;
      handlePhoto(teamKey, file, statusEl, listEl, nameInput).catch((err) => {
        console.error(err);
        statusEl.textContent = "Something went wrong reading that photo — try again, or add players manually below.";
      });
    });

    setupManualSearch(teamKey, container);

    container.addEventListener("click", (e) => {
      const btn = e.target.closest(".chip-remove");
      if (!btn) return;
      teamState[teamKey].manual.splice(Number(btn.dataset.i), 1);
      renderManualList(teamKey, container);
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
  }

  function init() {
    initTeamPanel("A");
    initTeamPanel("B");

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
