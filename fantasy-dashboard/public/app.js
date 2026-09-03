const POLL_MS = 30000;

const $ = (sel) => document.querySelector(sel);

let pollTimer = null;

function renderPlayer(p) {
  const el = document.createElement("div");
  el.className = "player";
  el.innerHTML = `
    <div class="info">
      <div class="pname">${p.name}<span class="badge">${p.pos}${p.team ? " · " + p.team : ""}</span></div>
      <div class="line">${p.line}</div>
    </div>
    <div class="pts">${p.pts.toFixed(1)}</div>
  `;
  return el;
}

function renderTeam(colEl, team) {
  colEl.innerHTML = "";
  if (!team.players.length) {
    colEl.innerHTML = `<div class="empty">No roster loaded yet — send Claude a matchup photo to fill this in.</div>`;
    return;
  }
  for (const p of team.players) {
    colEl.appendChild(renderPlayer(p));
  }
}

async function refresh(force = false) {
  const btn = $("#refresh");
  const statusText = $("#status-text");
  const dot = $("#dot");
  btn.disabled = true;
  statusText.textContent = "Updating…";

  try {
    const res = await fetch(`/api/matchup${force ? "?force=1" : ""}`);
    if (!res.ok) throw new Error(`Request failed: ${res.status}`);
    const data = await res.json();

    $("#meta").textContent = `${data.season} · Week ${data.week}`;
    $("#name-a").textContent = data.teamA.name;
    $("#name-b").textContent = data.teamB.name;
    $("#col-a-title").textContent = data.teamA.name;
    $("#col-b-title").textContent = data.teamB.name;
    $("#pts-a").textContent = data.teamA.total.toFixed(1);
    $("#pts-b").textContent = data.teamB.total.toFixed(1);

    renderTeam($("#col-a"), data.teamA);
    renderTeam($("#col-b"), data.teamB);

    const sum = data.teamA.total + data.teamB.total || 1;
    $("#bar-a").style.width = `${(data.teamA.total / sum) * 100}%`;
    $("#bar-b").style.width = `${(data.teamB.total / sum) * 100}%`;

    dot.classList.add("live");
    const fetchedAt = new Date(data.fetchedAt);
    $("#last-updated").textContent = `Data last updated ${fetchedAt.toLocaleTimeString()}`;
    statusText.textContent = `Checked ${new Date().toLocaleTimeString()}`;
  } catch (err) {
    dot.classList.remove("live");
    statusText.textContent = "Update failed — will retry";
    console.error(err);
  } finally {
    btn.disabled = false;
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(false), POLL_MS);
}

$("#refresh").addEventListener("click", () => refresh(true));

refresh();
startPolling();
