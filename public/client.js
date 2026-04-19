const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const ui = {
  menu: document.getElementById("menu"),
  hud: document.getElementById("hud"),
  playerNameInput: document.getElementById("player-name-input"),
  mapSizeInput: document.getElementById("map-size-input"),
  roomCodeInput: document.getElementById("room-code-input"),
  createRoomButton: document.getElementById("create-room-button"),
  joinRoomButton: document.getElementById("join-room-button"),
  menuMessage: document.getElementById("menu-message"),
  roomCodeLabel: document.getElementById("room-code-label"),
  phaseLabel: document.getElementById("phase-label"),
  timerLabel: document.getElementById("timer-label"),
  roundLabel: document.getElementById("round-label"),
  turnLabel: document.getElementById("turn-label"),
  readyLabel: document.getElementById("ready-label"),
  scoreboard: document.getElementById("scoreboard"),
  startGameButton: document.getElementById("start-game-button"),
  messages: document.getElementById("messages"),
  touchActions: document.getElementById("touch-actions"),
  centerCameraButton: document.getElementById("center-camera-button"),
  zoomOutButton: document.getElementById("zoom-out-button"),
  zoomInButton: document.getElementById("zoom-in-button")
};

const state = {
  token: localStorage.getItem("move-and-shoot-token") || "",
  roomCode: "",
  snapshot: null,
  clockOffsetMs: 0,
  pollTimer: null,
  animationFrame: 0,
  inputStep: "move",
  draftMoveTarget: null,
  draftAimDir: { x: 0, y: -1 },
  messageLog: ["Click a move point, then click an aim point."],
  lastPhase: "",
  lastRoundSummaryKey: "",
  lastMatchSummaryKey: "",
  lastPlanningKey: "",
  pendingPlanSave: null,
  isTouch: window.matchMedia("(pointer: coarse)").matches,
  camera: {
    x: 0,
    y: 0,
    zoom: null,
    panX: 0,
    panY: 0
  },
  dragCamera: {
    active: false,
    startX: 0,
    startY: 0,
    originX: 0,
    originY: 0,
    mode: "spectator"
  }
};

class SoundBoard {
  constructor() {
    this.context = null;
    this.enabled = false;
  }

  unlock() {
    if (!this.context) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) {
        return;
      }
      this.context = new AudioContextClass();
    }
    if (this.context.state === "suspended") {
      this.context.resume();
    }
    this.enabled = true;
  }

  tone(frequency, duration, type = "triangle", gainValue = 0.03) {
    if (!this.enabled || !this.context) {
      return;
    }
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    gain.gain.setValueAtTime(gainValue, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(this.context.destination);
    oscillator.start(now);
    oscillator.stop(now + duration);
  }

  shoot() {
    this.tone(620, 0.08, "square", 0.045);
  }

  hit() {
    this.tone(180, 0.12, "sawtooth", 0.05);
  }

  death() {
    this.tone(120, 0.22, "triangle", 0.06);
  }

  countdown() {
    return;
  }
}

const sounds = new SoundBoard();

function pushMessage(text) {
  state.messageLog = [text, ...state.messageLog].slice(0, 8);
}

function currentServerNow() {
  return Date.now() + state.clockOffsetMs;
}

function resizeCanvas() {
  const ratio = window.devicePixelRatio || 1;
  canvas.width = Math.floor(window.innerWidth * ratio);
  canvas.height = Math.floor(window.innerHeight * ratio);
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
}

function normalize(vector, fallback = { x: 0, y: -1 }) {
  const length = Math.hypot(vector.x, vector.y);
  if (!length) {
    return { x: fallback.x, y: fallback.y };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function byId(id) {
  return state.snapshot?.players.find((entry) => entry.id === id) || null;
}

function getPhaseTimeRemaining() {
  if (!state.snapshot?.room.phaseEndsAt) {
    return null;
  }
  return Math.max(0, state.snapshot.room.phaseEndsAt - currentServerNow());
}

function formatSeconds(ms) {
  if (ms === null) {
    return "--";
  }
  return `${(ms / 1000).toFixed(1)}s`;
}

function visiblePlayers() {
  if (!state.snapshot) {
    return [];
  }
  return state.snapshot.players.filter((player) => player.visibleToYou || player.id === state.snapshot.you.id);
}

function getAnimatedPlayerPosition(player) {
  if (!state.snapshot?.match?.active || !state.snapshot.match.movement || !state.snapshot.match.map) {
    return { x: player.x, y: player.y };
  }

  const movement = state.snapshot.match.movement;
  const entry = movement.byPlayer?.[player.id];
  if (!entry) {
    return { x: player.x, y: player.y };
  }

  if (state.snapshot.room.phase !== "movement") {
    return { x: entry.end.x, y: entry.end.y };
  }

  const elapsed = currentServerNow() - movement.startedAt;
  const activeDuration = Math.max(entry.haltedAtMs || movement.durationMs, 1);
  const movementT = clamp(elapsed / activeDuration, 0, 1);
  return lerpPoint(entry.start, entry.end, movementT);
}

function getCameraTarget() {
  if (!state.snapshot) {
    return { x: 0, y: 0 };
  }
  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  if (state.snapshot.you.alive) {
    return getAnimatedPlayerPosition(you);
  }
  return { x: state.camera.x, y: state.camera.y };
}

function ensureCamera() {
  if (!state.snapshot?.match?.map) {
    state.camera.x = 0;
    state.camera.y = 0;
    return;
  }

  const map = state.snapshot.match.map;
  if (!state.camera.zoom) {
    state.camera.zoom = state.isTouch ? 0.6 : 0.78;
  }
  if (state.snapshot.you.alive) {
    const target = getCameraTarget();
    state.camera.x = clamp(target.x + state.camera.panX, 0, map.width);
    state.camera.y = clamp(target.y + state.camera.panY, 0, map.height);
  } else {
    state.camera.zoom = clamp(state.camera.zoom || 0.55, 0.3, 1.6);
    state.camera.x = clamp(state.camera.x || map.width / 2, 0, map.width);
    state.camera.y = clamp(state.camera.y || map.height / 2, 0, map.height);
  }
}

function worldToScreen(point) {
  const zoom = state.camera.zoom || 1;
  return {
    x: (point.x - state.camera.x) * zoom + window.innerWidth / 2,
    y: (point.y - state.camera.y) * zoom + window.innerHeight / 2
  };
}

function screenToWorld(point) {
  const zoom = state.camera.zoom || 1;
  return {
    x: (point.x - window.innerWidth / 2) / zoom + state.camera.x,
    y: (point.y - window.innerHeight / 2) / zoom + state.camera.y
  };
}

function api(path, options = {}) {
  return fetch(path, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json"
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(async (response) => {
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(json.error || "Request failed");
    }
    return json;
  });
}

async function joinRoom(roomCode) {
  const name = ui.playerNameInput.value.trim().slice(0, 20);
  const payload = roomCode ? { roomCode } : {};
  if (name) {
    payload.name = name;
  }
  payload.mapGridSize = Number(ui.mapSizeInput.value) || 2;
  const result = await api("/api/join", { method: "POST", body: payload });
  state.token = result.token;
  state.roomCode = result.roomCode;
  localStorage.setItem("move-and-shoot-token", result.token);
  ui.roomCodeInput.value = result.roomCode;
  ui.menu.classList.add("hidden");
  ui.hud.classList.remove("hidden");
  pushMessage(`Joined room ${result.roomCode} as ${result.name}.`);
  startPolling();
}

function startPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
  }
  pollState();
  state.pollTimer = setInterval(pollState, 250);
}

async function pollState() {
  if (!state.token) {
    return;
  }
  try {
    const snapshot = await api(`/api/state?token=${encodeURIComponent(state.token)}`);
    state.clockOffsetMs = snapshot.serverNow - Date.now();
    handleSnapshot(snapshot);
  } catch (error) {
    ui.menu.classList.remove("hidden");
    ui.hud.classList.add("hidden");
    ui.menuMessage.textContent = error.message;
  }
}

function sameSummaryKey(summary) {
  return JSON.stringify(summary || null);
}

function handleSnapshot(snapshot) {
  const previous = state.snapshot;
  state.snapshot = snapshot;
  state.roomCode = snapshot.room.code;
  const planningKey = snapshot.match.active
    ? `${snapshot.match.currentRound}-${snapshot.match.turnNumber}-${snapshot.room.phase}`
    : snapshot.room.phase;

  if (snapshot.room.phase !== state.lastPhase) {
    if (snapshot.room.phase === "shooting") {
      sounds.shoot();
    }
    pushMessage(snapshot.room.phaseLabel);
    state.lastPhase = snapshot.room.phase;
  }

  const roundSummaryKey = sameSummaryKey(snapshot.summaries.round);
  if (snapshot.summaries.round && roundSummaryKey !== state.lastRoundSummaryKey) {
    state.lastRoundSummaryKey = roundSummaryKey;
    if (snapshot.summaries.round.draw) {
      pushMessage(`Round ${snapshot.summaries.round.roundNumber} ended in a draw.`);
    } else {
      const winner = byId(snapshot.summaries.round.winnerId);
      pushMessage(
        winner
          ? `Round ${snapshot.summaries.round.roundNumber} winner: ${winner.name}.`
          : `Round ${snapshot.summaries.round.roundNumber} complete.`
      );
    }
  }

  const matchSummaryKey = sameSummaryKey(snapshot.summaries.match);
  if (snapshot.summaries.match && matchSummaryKey !== state.lastMatchSummaryKey) {
    state.lastMatchSummaryKey = matchSummaryKey;
    if (snapshot.summaries.match.winnerId) {
      const winner = snapshot.summaries.match.scoreboard.find(
        (entry) => entry.id === snapshot.summaries.match.winnerId
      );
      pushMessage(`Match winner: ${winner ? winner.name : "Unknown"}.`);
    } else {
      pushMessage("Match ended in a tie.");
    }
  }

  if (planningKey !== state.lastPlanningKey) {
    state.lastPlanningKey = planningKey;
    state.inputStep = "move";
    state.draftMoveTarget = snapshot.planning?.plan?.moveTarget || null;
    state.draftAimDir = snapshot.planning?.plan?.aimDir || snapshot.you.lastAimDir || { x: 0, y: -1 };
  }

  if (previous && previous.players && snapshot.players) {
    snapshot.players.forEach((player) => {
      const older = previous.players.find((entry) => entry.id === player.id);
      if (older && older.alive && !player.alive && snapshot.match.active) {
        sounds.hit();
        if (player.id === snapshot.you.id) {
          sounds.death();
        }
      }
    });
  }

  if (snapshot.room.phase === "planning") {
    const remaining = getPhaseTimeRemaining();
    if (remaining !== null && remaining <= 3000) {
      const wholeSeconds = Math.ceil(remaining / 1000);
      if (wholeSeconds >= 1 && wholeSeconds <= 3) {
        if (state.pendingPlanSave !== wholeSeconds) {
          sounds.countdown();
          state.pendingPlanSave = wholeSeconds;
        }
      }
    } else {
      state.pendingPlanSave = null;
    }
  }

  ensureCamera();
  renderHud();
}

function renderHud() {
  if (!state.snapshot) {
    return;
  }
  ui.roomCodeLabel.textContent = state.snapshot.room.code;
  ui.phaseLabel.textContent = state.snapshot.room.phaseLabel;
  ui.timerLabel.textContent = formatSeconds(getPhaseTimeRemaining());
  ui.roundLabel.textContent = state.snapshot.match.active
    ? `${state.snapshot.match.currentRound} / ${state.snapshot.match.totalRounds}`
    : "- / 3";
  ui.turnLabel.textContent = state.snapshot.match.active
    ? String(state.snapshot.match.turnNumber || "-")
    : "-";
  ui.readyLabel.textContent = state.snapshot.planning?.ready
    ? "Locked In"
    : state.snapshot.you.alive
      ? "Planning"
      : "Spectating";
  ui.startGameButton.classList.toggle(
    "hidden",
    !(state.snapshot.you.isHost && state.snapshot.room.phase === "lobby")
  );
  ui.startGameButton.disabled = state.snapshot.room.connectedCount < state.snapshot.room.minPlayers;
  ui.startGameButton.textContent =
    state.snapshot.room.connectedCount < state.snapshot.room.minPlayers
      ? "Need 2 Players"
      : "Start Game";

  ui.scoreboard.innerHTML = "";
  const scoreboard = [...state.snapshot.players].sort((a, b) => b.wins - a.wins || b.survivalMs - a.survivalMs);
  scoreboard.forEach((player) => {
    const row = document.createElement("div");
    row.className = "score-row";
    const name = document.createElement("div");
    name.className = "score-name";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = player.color;
    const text = document.createElement("span");
    text.textContent = `${player.name}${player.id === state.snapshot.room.hostId ? " (Host)" : ""}${player.id === state.snapshot.you.id ? " (You)" : ""}${!player.connected ? " [DC]" : ""}`;
    name.append(swatch, text);
    const meta = document.createElement("div");
    meta.textContent = `${player.wins}W`;
    row.append(name, meta);
    ui.scoreboard.append(row);
  });

  ui.messages.innerHTML = "";
  state.messageLog.forEach((message) => {
    const row = document.createElement("div");
    row.className = "message";
    row.textContent = message;
    ui.messages.append(row);
  });

  ui.touchActions.classList.toggle("hidden", !state.isTouch);
}

function drawBackground(map) {
  ctx.fillStyle = "#ede2c8";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  const grid = 120 * (state.camera.zoom || 1);
  ctx.strokeStyle = "rgba(92, 78, 50, 0.06)";
  ctx.lineWidth = 1;
  const offsetX = ((window.innerWidth / 2 - state.camera.x * state.camera.zoom) % grid + grid) % grid;
  const offsetY = ((window.innerHeight / 2 - state.camera.y * state.camera.zoom) % grid + grid) % grid;

  for (let x = offsetX; x < window.innerWidth; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, window.innerHeight);
    ctx.stroke();
  }
  for (let y = offsetY; y < window.innerHeight; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(window.innerWidth, y);
    ctx.stroke();
  }

  const topLeft = worldToScreen({ x: 0, y: 0 });
  const bottomRight = worldToScreen({ x: map.width, y: map.height });
  ctx.strokeStyle = "rgba(41, 31, 17, 0.35)";
  ctx.lineWidth = 4;
  ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
}

function drawBuildings(map) {
  for (const building of map.buildings) {
    const center = worldToScreen(building);
    ctx.save();
    ctx.translate(center.x, center.y);
    ctx.rotate((building.angleDeg * Math.PI) / 180);
    ctx.scale(state.camera.zoom, state.camera.zoom);
    ctx.fillStyle = "#7f6a4f";
    ctx.fillRect(-building.width / 2, -building.height / 2, building.width, building.height);
    ctx.strokeStyle = "rgba(255,255,255,0.22)";
    ctx.lineWidth = 2 / state.camera.zoom;
    ctx.strokeRect(-building.width / 2, -building.height / 2, building.width, building.height);
    ctx.restore();
  }
}

function drawMoveAndAimPreview() {
  if (!state.snapshot?.you.alive || state.snapshot.room.phase !== "planning") {
    return;
  }
  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  const start = getAnimatedPlayerPosition(you);
  const moveTarget = state.draftMoveTarget || state.snapshot.planning?.plan?.moveTarget;
  const aimDir = state.draftAimDir || state.snapshot.planning?.plan?.aimDir || state.snapshot.you.lastAimDir;
  if (moveTarget) {
    const startScreen = worldToScreen(start);
    const endScreen = worldToScreen(moveTarget);
    ctx.strokeStyle = "rgba(45, 106, 79, 0.92)";
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(startScreen.x, startScreen.y);
    ctx.lineTo(endScreen.x, endScreen.y);
    ctx.stroke();
    ctx.setLineDash([]);

    const aimEnd = {
      x: moveTarget.x + aimDir.x * 260,
      y: moveTarget.y + aimDir.y * 260
    };
    const aimScreen = worldToScreen(aimEnd);
    ctx.strokeStyle = "rgba(162, 62, 47, 0.94)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(endScreen.x, endScreen.y);
    ctx.lineTo(aimScreen.x, aimScreen.y);
    ctx.stroke();
  } else {
    const startScreen = worldToScreen(start);
    const aimEnd = {
      x: start.x + aimDir.x * 120,
      y: start.y + aimDir.y * 120
    };
    const aimScreen = worldToScreen(aimEnd);
    ctx.strokeStyle = "rgba(162, 62, 47, 0.75)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(startScreen.x, startScreen.y);
    ctx.lineTo(aimScreen.x, aimScreen.y);
    ctx.stroke();
  }
}

function drawBullets() {
  if (!state.snapshot?.match?.shooting || state.snapshot.room.phase !== "shooting") {
    return;
  }
  const shooting = state.snapshot.match.shooting;
  const elapsed = currentServerNow() - shooting.startedAt;
  shooting.bullets.forEach((bullet) => {
    const fraction = clamp(elapsed / Math.max(bullet.stopTimeMs, 1), 0, 1);
    const currentPoint = {
      x: bullet.origin.x + bullet.direction.x * (bullet.stopTimeMs / 1000) * state.snapshot.config.bulletSpeed * fraction,
      y: bullet.origin.y + bullet.direction.y * (bullet.stopTimeMs / 1000) * state.snapshot.config.bulletSpeed * fraction
    };
    const head = worldToScreen(currentPoint);
    const tail = worldToScreen({
      x: currentPoint.x - bullet.direction.x * 48,
      y: currentPoint.y - bullet.direction.y * 48
    });
    ctx.strokeStyle = "rgba(255, 244, 196, 0.9)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
  });
}

function drawPlayer(player) {
  const position = getAnimatedPlayerPosition(player);
  const screen = worldToScreen(position);
  const radius = state.snapshot.config.playerRadius * state.camera.zoom;
  const alive = player.alive;
  const brimRadius = radius * 1.3;
  const crownRadius = radius * 0.72;
  const crownCenterX = 0;
  const crownCenterY = 0;
  ctx.save();
  ctx.translate(screen.x, screen.y);

  ctx.fillStyle = alive ? "rgba(52, 34, 19, 0.48)" : "rgba(60, 60, 60, 0.28)";
  ctx.beginPath();
  ctx.arc(0, 0, brimRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = alive ? player.color : "rgba(110, 110, 110, 0.5)";
  ctx.beginPath();
  ctx.arc(crownCenterX, crownCenterY, crownRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 248, 232, 0.32)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(crownCenterX, crownCenterY, crownRadius * 0.72, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(33, 18, 9, 0.58)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(0, 0, brimRadius, 0, Math.PI * 2);
  ctx.stroke();

  const aimDir = player.lastAimDir || { x: 0, y: -1 };
  ctx.strokeStyle = alive ? "rgba(33, 18, 9, 0.7)" : "rgba(33,18,9,0.25)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(crownCenterX, crownCenterY);
  ctx.lineTo(aimDir.x * brimRadius * 1.15, aimDir.y * brimRadius * 1.15);
  ctx.stroke();
  ctx.restore();

  ctx.fillStyle = "#20170f";
  ctx.font = "600 13px Trebuchet MS";
  ctx.textAlign = "center";
  ctx.fillText(player.name, screen.x, screen.y - brimRadius - 16);
}

function drawPlayers() {
  visiblePlayers().forEach((player) => {
    drawPlayer(player);
  });
}

function drawSpectatorHint() {
  if (!state.snapshot || state.snapshot.you.alive) {
    return;
  }
  ctx.fillStyle = "rgba(18, 15, 10, 0.7)";
  ctx.font = "600 14px Trebuchet MS";
  ctx.textAlign = "left";
  ctx.fillText("Spectating: drag to pan, use buttons or wheel to zoom.", 22, window.innerHeight - 24);
}

function drawOverlayText() {
  if (!state.snapshot) {
    return;
  }
  ctx.fillStyle = "rgba(18,15,10,0.82)";
  ctx.font = "700 18px Trebuchet MS";
  ctx.textAlign = "center";
  if (state.snapshot.room.phase === "planning") {
    ctx.fillText(
      state.inputStep === "move" ? "Choose move destination" : "Choose shoot direction",
      window.innerWidth / 2,
      window.innerHeight - 26
    );
  }

  if (state.snapshot.room.phase === "round_end" && state.snapshot.summaries?.round) {
    const summary = state.snapshot.summaries.round;
    const winner = summary.winnerId
      ? state.snapshot.players.find((player) => player.id === summary.winnerId)
      : null;
    ctx.textAlign = "center";
    ctx.font = "700 34px Trebuchet MS";
    ctx.fillText(
      summary.draw ? "Round Draw" : `${winner ? winner.name : "A player"} Won The Round`,
      window.innerWidth / 2,
      window.innerHeight / 2
    );
  }

  if (state.snapshot.room.phase === "match_end" && state.snapshot.summaries?.match) {
    const summary = state.snapshot.summaries.match;
    const winner = summary.winnerId
      ? summary.scoreboard.find((player) => player.id === summary.winnerId)
      : null;
    ctx.textAlign = "center";
    ctx.font = "700 40px Trebuchet MS";
    ctx.fillText(
      winner ? `${winner.name} Won The Match` : "Match Draw",
      window.innerWidth / 2,
      window.innerHeight / 2
    );
  }

  ctx.font = "500 13px Trebuchet MS";
  ctx.textAlign = "left";
  ctx.fillText("Wheel to zoom. Right-drag or WASD/arrow keys to pan. Press C to recenter.", 22, window.innerHeight - 24);
}

function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);

  if (!state.snapshot?.match?.active || !state.snapshot.match.map) {
    ctx.fillStyle = "rgba(22,18,13,0.82)";
    ctx.font = "700 30px Trebuchet MS";
    ctx.textAlign = "center";
    ctx.fillText("Move and Shoot", window.innerWidth / 2, window.innerHeight / 2 - 20);
    ctx.font = "400 18px Trebuchet MS";
    ctx.fillText("Create a room or enter a room code to join.", window.innerWidth / 2, window.innerHeight / 2 + 20);
    state.animationFrame = requestAnimationFrame(render);
    return;
  }

  ensureCamera();
  drawBackground(state.snapshot.match.map);
  drawBuildings(state.snapshot.match.map);
  drawMoveAndAimPreview();
  drawBullets();
  drawPlayers();
  drawSpectatorHint();
  drawOverlayText();
  state.animationFrame = requestAnimationFrame(render);
}

function getCanvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}

async function savePlan(plan) {
  if (!state.token) {
    return;
  }
  await api("/api/plan", {
    method: "POST",
    body: {
      token: state.token,
      moveTarget: plan.moveTarget,
      aimDir: plan.aimDir
    }
  });
}

async function startGame() {
  if (!state.token) {
    return;
  }
  await api("/api/start", {
    method: "POST",
    body: {
      token: state.token
    }
  });
}

function clampMoveTarget(worldPoint) {
  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  const dx = worldPoint.x - you.x;
  const dy = worldPoint.y - you.y;
  const distance = Math.hypot(dx, dy);
  if (!distance) {
    return { x: you.x, y: you.y };
  }
  if (distance <= state.snapshot.config.moveRange) {
    return worldPoint;
  }
  const dir = normalize({ x: dx, y: dy });
  return {
    x: you.x + dir.x * state.snapshot.config.moveRange,
    y: you.y + dir.y * state.snapshot.config.moveRange
  };
}

async function handlePlanningClick(worldPoint) {
  if (!state.snapshot?.you.alive || state.snapshot.room.phase !== "planning") {
    return;
  }

  if (state.inputStep === "move") {
    state.draftMoveTarget = clampMoveTarget(worldPoint);
    state.draftAimDir = state.snapshot.planning?.plan?.aimDir || state.snapshot.you.lastAimDir || { x: 0, y: -1 };
    pushMessage("Move target set. Click again to aim.");
    state.inputStep = "aim";
    try {
      await savePlan({
        moveTarget: state.draftMoveTarget,
        aimDir: state.draftAimDir
      });
    } catch (error) {
      pushMessage(error.message);
    }
    return;
  }

  const origin = state.draftMoveTarget || (byId(state.snapshot.you.id) || state.snapshot.you);
  state.draftAimDir = normalize({
    x: worldPoint.x - origin.x,
    y: worldPoint.y - origin.y
  }, state.snapshot.you.lastAimDir);

  try {
    await savePlan({
      moveTarget: state.draftMoveTarget || { x: origin.x, y: origin.y },
      aimDir: state.draftAimDir
    });
    pushMessage("Plan updated.");
  } catch (error) {
    pushMessage(error.message);
  }
  state.inputStep = "move";
}

canvas.addEventListener("pointerdown", async (event) => {
  sounds.unlock();
  if (!state.snapshot?.match?.active) {
    return;
  }
  if (!state.snapshot.you.alive || event.button === 1 || event.button === 2) {
    state.dragCamera.active = true;
    state.dragCamera.startX = event.clientX;
    state.dragCamera.startY = event.clientY;
    state.dragCamera.originX = state.snapshot.you.alive ? state.camera.panX : state.camera.x;
    state.dragCamera.originY = state.snapshot.you.alive ? state.camera.panY : state.camera.y;
    state.dragCamera.mode = state.snapshot.you.alive ? "alive" : "spectator";
    return;
  }
  if (event.button !== 0) {
    return;
  }
  const point = getCanvasPoint(event);
  const world = screenToWorld(point);
  await handlePlanningClick(world);
});

window.addEventListener("pointermove", (event) => {
  if (!state.snapshot?.match?.active || !state.dragCamera.active) {
    return;
  }
  const dx = (event.clientX - state.dragCamera.startX) / state.camera.zoom;
  const dy = (event.clientY - state.dragCamera.startY) / state.camera.zoom;
  if (state.dragCamera.mode === "alive") {
    state.camera.panX = state.dragCamera.originX - dx;
    state.camera.panY = state.dragCamera.originY - dy;
    return;
  }
  state.camera.x = state.dragCamera.originX - dx;
  state.camera.y = state.dragCamera.originY - dy;
});

window.addEventListener("pointercancel", () => {
  state.dragCamera.active = false;
});

window.addEventListener("pointerup", () => {
  state.dragCamera.active = false;
});

window.addEventListener("wheel", (event) => {
  event.preventDefault();
  state.camera.zoom = clamp(state.camera.zoom - Math.sign(event.deltaY) * 0.07, 0.3, 1.6);
}, { passive: false });

window.addEventListener("contextmenu", (event) => {
  if (state.snapshot?.match?.active) {
    event.preventDefault();
  }
});

window.addEventListener("keydown", (event) => {
  if (!state.snapshot?.match?.active || !state.snapshot.you.alive) {
    return;
  }
  const step = 80;
  if (event.key === "ArrowUp" || event.key === "w" || event.key === "W") {
    state.camera.panY -= step;
  } else if (event.key === "ArrowDown" || event.key === "s" || event.key === "S") {
    state.camera.panY += step;
  } else if (event.key === "ArrowLeft" || event.key === "a" || event.key === "A") {
    state.camera.panX -= step;
  } else if (event.key === "ArrowRight" || event.key === "d" || event.key === "D") {
    state.camera.panX += step;
  } else if (event.key === "c" || event.key === "C") {
    state.camera.panX = 0;
    state.camera.panY = 0;
  } else {
    return;
  }
  event.preventDefault();
});

window.addEventListener("beforeunload", () => {
  if (!state.token) {
    return;
  }
  navigator.sendBeacon(
    "/api/leave",
    new Blob([JSON.stringify({ token: state.token })], { type: "application/json" })
  );
});

ui.createRoomButton.addEventListener("click", async () => {
  sounds.unlock();
  ui.menuMessage.textContent = "Creating room...";
  try {
    await joinRoom("");
  } catch (error) {
    ui.menuMessage.textContent = error.message;
  }
});

ui.joinRoomButton.addEventListener("click", async () => {
  sounds.unlock();
  ui.menuMessage.textContent = "Joining room...";
  try {
    await joinRoom(ui.roomCodeInput.value);
  } catch (error) {
    ui.menuMessage.textContent = error.message;
  }
});

ui.startGameButton.addEventListener("click", async () => {
  sounds.unlock();
  try {
    await startGame();
    pushMessage("Host started the match countdown.");
  } catch (error) {
    pushMessage(error.message);
  }
});

ui.roomCodeInput.addEventListener("input", () => {
  ui.roomCodeInput.value = ui.roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
});

ui.centerCameraButton.addEventListener("click", () => {
  if (!state.snapshot?.match?.map) {
    return;
  }
  state.camera.panX = 0;
  state.camera.panY = 0;
  state.camera.x = state.snapshot.match.map.width / 2;
  state.camera.y = state.snapshot.match.map.height / 2;
});

ui.zoomOutButton.addEventListener("click", () => {
  state.camera.zoom = clamp(state.camera.zoom - 0.1, 0.3, 1.6);
});

ui.zoomInButton.addEventListener("click", () => {
  state.camera.zoom = clamp(state.camera.zoom + 0.1, 0.3, 1.6);
});

window.addEventListener("resize", resizeCanvas);
resizeCanvas();
render();
