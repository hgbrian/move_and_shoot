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
  scoreLabel: document.getElementById("score-label"),
  startGameButton: document.getElementById("start-game-button"),
  topActionSlot: document.getElementById("top-action-slot")
};

const state = {
  token: localStorage.getItem("move-and-shoot-token") || "",
  roomCode: "",
  snapshot: null,
  clockOffsetMs: 0,
  lastServerNowMs: 0,
  lastPerfNowMs: 0,
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
  playback: {
    phase: "",
    serverStartMs: 0,
    clientStartPerfMs: 0,
    durationMs: 0
  },
  dragPlan: {
    active: false,
    mode: "",
    pointerType: ""
  },
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

const FIXED_CAMERA_ZOOM = 0.624;
const CAMERA_FOLLOW_SMOOTHING = 0.2;
const CLOCK_OFFSET_SMOOTHING = 0.15;

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
  if (!state.lastServerNowMs || !state.lastPerfNowMs) {
    return Date.now() + state.clockOffsetMs;
  }
  return state.lastServerNowMs + (performance.now() - state.lastPerfNowMs);
}

function currentPlaybackServerNow() {
  const playback = state.playback;
  if (
    playback.phase &&
    state.snapshot?.room.phase === playback.phase &&
    playback.serverStartMs &&
    playback.clientStartPerfMs
  ) {
    const elapsed = performance.now() - playback.clientStartPerfMs;
    const clampedElapsed = Math.max(0, Math.min(elapsed, playback.durationMs || elapsed));
    return playback.serverStartMs + clampedElapsed;
  }
  return currentServerNow();
}

function getPlayViewport() {
  return {
    x: 0,
    y: 0,
    size: Math.min(window.innerWidth, window.innerHeight),
    centerX: window.innerWidth / 2,
    centerY: window.innerHeight / 2,
    right: window.innerWidth,
    bottom: window.innerHeight
  };
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

  const interpolateMovementEntry = (movementEntry, elapsedMs) => {
    if (!movementEntry?.samples?.length) {
      return { x: movementEntry.end.x, y: movementEntry.end.y };
    }
    if (elapsedMs <= 0) {
      return { x: movementEntry.samples[0].x, y: movementEntry.samples[0].y };
    }
    for (let i = 1; i < movementEntry.samples.length; i += 1) {
      const previous = movementEntry.samples[i - 1];
      const current = movementEntry.samples[i];
      if (elapsedMs <= current.timeMs) {
        const duration = Math.max(current.timeMs - previous.timeMs, 1);
        const t = clamp((elapsedMs - previous.timeMs) / duration, 0, 1);
        return lerpPoint(previous, current, t);
      }
    }
    const last = movementEntry.samples[movementEntry.samples.length - 1];
    return { x: last.x, y: last.y };
  };

  if (state.snapshot.room.phase !== "movement") {
    return interpolateMovementEntry(entry, entry.haltedAtMs || movement.durationMs);
  }

  const elapsed = currentPlaybackServerNow() - movement.startedAt;
  const activeDuration = Math.max(entry.haltedAtMs || movement.durationMs, 1);
  return interpolateMovementEntry(entry, clamp(elapsed, 0, activeDuration));
}

function getCameraTarget() {
  if (!state.snapshot) {
    return { x: 0, y: 0 };
  }
  if (
    state.snapshot.room.phase === "shooting" &&
    state.snapshot.match?.shooting?.bullets?.length
  ) {
    const localBullet = state.snapshot.match.shooting.bullets.find(
      (bullet) => bullet.shooterId === state.snapshot.you.id
    );
    if (localBullet) {
      const shooting = state.snapshot.match.shooting;
      const elapsed = currentPlaybackServerNow() - shooting.startedAt;
      const clampedElapsed = clamp(elapsed, 0, localBullet.stopTimeMs);
      const travelDistance =
        (clampedElapsed / 1000) * state.snapshot.config.bulletSpeed;
      return {
        x: localBullet.origin.x + localBullet.direction.x * travelDistance,
        y: localBullet.origin.y + localBullet.direction.y * travelDistance
      };
    }
  }
  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  if (state.snapshot.you.alive) {
    return getAnimatedPlayerPosition(you);
  }
  return { x: state.camera.x, y: state.camera.y };
}

function getLocalShotBullet() {
  if (
    !state.snapshot ||
    state.snapshot.room.phase !== "shooting" ||
    !state.snapshot.match?.shooting?.bullets?.length
  ) {
    return null;
  }
  return (
    state.snapshot.match.shooting.bullets.find(
      (bullet) => bullet.shooterId === state.snapshot.you.id
    ) || null
  );
}

function ensureCamera() {
  if (!state.snapshot?.match?.map) {
    state.camera.x = 0;
    state.camera.y = 0;
    return;
  }

  const map = state.snapshot.match.map;
  if (!state.camera.zoom) {
    state.camera.zoom = FIXED_CAMERA_ZOOM;
  }
  if (state.snapshot.you.alive) {
    const target = getCameraTarget();
    const localShotBullet = getLocalShotBullet();
    state.camera.zoom = FIXED_CAMERA_ZOOM;
    state.camera.panX = 0;
    state.camera.panY = 0;
    const desiredX = clamp(target.x, 0, map.width);
    const desiredY = clamp(target.y, 0, map.height);
    if (
      !state.camera.x && !state.camera.y ||
      state.isTouch ||
      state.snapshot.room.phase === "planning" ||
      state.snapshot.room.phase === "movement" ||
      localShotBullet
    ) {
      state.camera.x = desiredX;
      state.camera.y = desiredY;
    } else {
      state.camera.x = lerp(state.camera.x, desiredX, CAMERA_FOLLOW_SMOOTHING);
      state.camera.y = lerp(state.camera.y, desiredY, CAMERA_FOLLOW_SMOOTHING);
    }
  } else {
    state.camera.zoom = FIXED_CAMERA_ZOOM;
    const desiredX = clamp(state.camera.x || map.width / 2, 0, map.width);
    const desiredY = clamp(state.camera.y || map.height / 2, 0, map.height);
    state.camera.x = lerp(state.camera.x || desiredX, desiredX, CAMERA_FOLLOW_SMOOTHING);
    state.camera.y = lerp(state.camera.y || desiredY, desiredY, CAMERA_FOLLOW_SMOOTHING);
  }
}

function worldToScreen(point) {
  const viewport = getPlayViewport();
  const zoom = state.camera.zoom || 1;
  return {
    x: (point.x - state.camera.x) * zoom + viewport.centerX,
    y: (point.y - state.camera.y) * zoom + viewport.centerY
  };
}

function screenToWorld(point) {
  const viewport = getPlayViewport();
  const zoom = state.camera.zoom || 1;
  return {
    x: (point.x - viewport.centerX) / zoom + state.camera.x,
    y: (point.y - viewport.centerY) / zoom + state.camera.y
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
    const measuredOffset = snapshot.serverNow - Date.now();
    if (!state.snapshot) {
      state.clockOffsetMs = measuredOffset;
    } else {
      state.clockOffsetMs =
        state.clockOffsetMs * (1 - CLOCK_OFFSET_SMOOTHING) +
        measuredOffset * CLOCK_OFFSET_SMOOTHING;
    }
    state.lastServerNowMs = snapshot.serverNow;
    state.lastPerfNowMs = performance.now();
    state.lastServerNowMs = snapshot.serverNow;
    state.lastPerfNowMs = performance.now();
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
    if (snapshot.room.phase === "movement" && snapshot.match?.movement) {
      state.playback = {
        phase: "movement",
        serverStartMs: snapshot.match.movement.startedAt,
        clientStartPerfMs: performance.now(),
        durationMs: snapshot.match.movement.durationMs
      };
    } else if (snapshot.room.phase === "shooting" && snapshot.match?.shooting) {
      state.playback = {
        phase: "shooting",
        serverStartMs: snapshot.match.shooting.startedAt,
        clientStartPerfMs: performance.now(),
        durationMs: snapshot.match.shooting.durationMs
      };
    } else if (snapshot.room.phase !== "movement" && snapshot.room.phase !== "shooting") {
      state.playback = {
        phase: "",
        serverStartMs: 0,
        clientStartPerfMs: 0,
        durationMs: 0
      };
    }
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
  const leaderWins = Math.max(0, ...state.snapshot.players.map((player) => player.wins || 0));
  ui.scoreLabel.textContent = `${state.snapshot.you.wins || 0}W / ${leaderWins}W`;
  ui.topActionSlot.classList.toggle(
    "hidden",
    !(state.snapshot.you.isHost && state.snapshot.room.phase === "lobby")
  );
  ui.startGameButton.disabled = state.snapshot.room.connectedCount < state.snapshot.room.minPlayers;
  ui.startGameButton.textContent =
    state.snapshot.room.connectedCount < state.snapshot.room.minPlayers
      ? "Need 2 Players"
      : "Start Game";
}

function drawBackground(map, viewport) {
  ctx.fillStyle = "#ede2c8";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

  const grid = 120 * (state.camera.zoom || 1);
  ctx.strokeStyle = "rgba(92, 78, 50, 0.06)";
  ctx.lineWidth = 1;
  const offsetX = ((viewport.centerX - state.camera.x * state.camera.zoom) % grid + grid) % grid;
  const offsetY = ((viewport.centerY - state.camera.y * state.camera.zoom) % grid + grid) % grid;

  for (let x = offsetX; x < viewport.right; x += grid) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, viewport.bottom);
    ctx.stroke();
  }
  for (let y = offsetY; y < viewport.bottom; y += grid) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(viewport.right, y);
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
  const elapsed = currentPlaybackServerNow() - shooting.startedAt;
  shooting.bullets.forEach((bullet) => {
    const fraction = clamp(elapsed / Math.max(bullet.stopTimeMs, 1), 0, 1);
    const currentPoint = {
      x: bullet.origin.x + bullet.direction.x * (bullet.stopTimeMs / 1000) * state.snapshot.config.bulletSpeed * fraction,
      y: bullet.origin.y + bullet.direction.y * (bullet.stopTimeMs / 1000) * state.snapshot.config.bulletSpeed * fraction
    };
    const head = worldToScreen(currentPoint);
    const tail = worldToScreen({
      x: currentPoint.x - bullet.direction.x * 28,
      y: currentPoint.y - bullet.direction.y * 28
    });
    ctx.strokeStyle = "rgba(6, 4, 3, 0.98)";
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(tail.x, tail.y);
    ctx.lineTo(head.x, head.y);
    ctx.stroke();
    ctx.strokeStyle = "rgba(120, 52, 28, 0.98)";
    ctx.lineWidth = 1.25;
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
  const gunStart = {
    x: crownCenterX + aimDir.x * (crownRadius * 0.35),
    y: crownCenterY + aimDir.y * (crownRadius * 0.35)
  };
  const gunEnd = {
    x: crownCenterX + aimDir.x * (brimRadius * 1.2),
    y: crownCenterY + aimDir.y * (brimRadius * 1.2)
  };
  const gunPerp = {
    x: -aimDir.y,
    y: aimDir.x
  };

  ctx.strokeStyle = alive ? "rgba(33, 18, 9, 0.88)" : "rgba(33,18,9,0.3)";
  ctx.lineWidth = 4;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(gunStart.x, gunStart.y);
  ctx.lineTo(gunEnd.x, gunEnd.y);
  ctx.stroke();

  ctx.strokeStyle = alive ? "rgba(255, 244, 230, 0.45)" : "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(gunStart.x, gunStart.y);
  ctx.lineTo(gunEnd.x, gunEnd.y);
  ctx.stroke();

  ctx.strokeStyle = alive ? "rgba(33, 18, 9, 0.7)" : "rgba(33,18,9,0.22)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(
    crownCenterX - aimDir.x * (crownRadius * 0.15) - gunPerp.x * (crownRadius * 0.28),
    crownCenterY - aimDir.y * (crownRadius * 0.15) - gunPerp.y * (crownRadius * 0.28)
  );
  ctx.lineTo(
    crownCenterX - aimDir.x * (crownRadius * 0.15) + gunPerp.x * (crownRadius * 0.28),
    crownCenterY - aimDir.y * (crownRadius * 0.15) + gunPerp.y * (crownRadius * 0.28)
  );
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
  const viewport = getPlayViewport();
  ctx.fillStyle = "rgba(18, 15, 10, 0.7)";
  ctx.font = "600 14px Trebuchet MS";
  ctx.textAlign = "left";
  ctx.fillText("Spectating: drag to pan.", viewport.x, viewport.bottom + 24);
}

function drawOverlayText() {
  if (!state.snapshot) {
    return;
  }
  const viewport = getPlayViewport();
  ctx.fillStyle = "rgba(18,15,10,0.82)";
  ctx.font = "700 18px Trebuchet MS";
  ctx.textAlign = "center";
  if (state.snapshot.room.phase === "planning") {
    ctx.fillText(
      state.inputStep === "move" ? "Choose move destination" : "Choose shoot direction",
      viewport.centerX,
      viewport.bottom + 26
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
      viewport.centerX,
      viewport.centerY
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
      viewport.centerX,
      viewport.centerY
    );
  }

  ctx.font = "500 13px Trebuchet MS";
  ctx.textAlign = "left";
  ctx.fillText("Camera follows you, then follows your bullet during the shot phase.", viewport.x, viewport.y - 10);
}

function render() {
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.fillStyle = "#e7ddc8";
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);

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
  const viewport = getPlayViewport();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, viewport.right, viewport.bottom);
  ctx.clip();
  drawBackground(state.snapshot.match.map, viewport);
  drawBuildings(state.snapshot.match.map);
  drawMoveAndAimPreview();
  drawBullets();
  drawPlayers();
  ctx.restore();
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

function pointInsidePlayArea(point) {
  const viewport = getPlayViewport();
  return !(
    point.x < viewport.x ||
    point.x > viewport.right ||
    point.y < viewport.y ||
    point.y > viewport.bottom
  );
}

function updatePlanDraftFromScreenPoint(point, mode) {
  if (!state.snapshot?.match?.active || !state.snapshot.you.alive || !pointInsidePlayArea(point)) {
    return false;
  }
  const world = screenToWorld(point);
  if (mode === "move") {
    state.draftMoveTarget = clampMoveTarget(world);
    return true;
  }

  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  const origin = state.draftMoveTarget || state.snapshot.planning?.plan?.moveTarget || { x: you.x, y: you.y };
  state.draftAimDir = normalize({
    x: world.x - origin.x,
    y: world.y - origin.y
  }, state.snapshot.you.lastAimDir);
  return true;
}

async function commitCurrentDraft(mode) {
  if (!state.snapshot?.you.alive || state.snapshot.room.phase !== "planning") {
    return;
  }

  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  if (mode === "move") {
    const moveTarget = state.draftMoveTarget || { x: you.x, y: you.y };
    await savePlan({
      moveTarget,
      aimDir: state.draftAimDir || state.snapshot.planning?.plan?.aimDir || state.snapshot.you.lastAimDir
    });
    pushMessage("Move target set. Drag again to aim.");
    state.inputStep = "aim";
    return;
  }

  const moveTarget =
    state.draftMoveTarget ||
    state.snapshot.planning?.plan?.moveTarget ||
    { x: you.x, y: you.y };
  await savePlan({
    moveTarget,
    aimDir: state.draftAimDir || state.snapshot.you.lastAimDir
  });
  pushMessage("Plan updated.");
  state.inputStep = "move";
}

function beginPlanDrag(point, pointerType) {
  if (!state.snapshot?.you.alive || state.snapshot.room.phase !== "planning") {
    return false;
  }
  const mode = state.inputStep;
  const updated = updatePlanDraftFromScreenPoint(point, mode);
  if (!updated) {
    return false;
  }
  state.dragPlan.active = true;
  state.dragPlan.mode = mode;
  state.dragPlan.pointerType = pointerType;
  return true;
}

function updatePlanDrag(point) {
  if (!state.dragPlan.active) {
    return;
  }
  updatePlanDraftFromScreenPoint(point, state.dragPlan.mode);
}

async function endPlanDrag() {
  if (!state.dragPlan.active) {
    return;
  }
  const mode = state.dragPlan.mode;
  state.dragPlan.active = false;
  state.dragPlan.mode = "";
  state.dragPlan.pointerType = "";
  try {
    await commitCurrentDraft(mode);
  } catch (error) {
    pushMessage(error.message);
  }
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
  if (event.pointerType === "touch") {
    return;
  }
  if (!state.snapshot.you.alive) {
    state.dragCamera.active = true;
    state.dragCamera.startX = event.clientX;
    state.dragCamera.startY = event.clientY;
    state.dragCamera.originX = state.camera.x;
    state.dragCamera.originY = state.camera.y;
    state.dragCamera.mode = "spectator";
    return;
  }
  if (event.button !== 0) {
    return;
  }
  const point = getCanvasPoint(event);
  beginPlanDrag(point, "mouse");
});

canvas.addEventListener(
  "touchstart",
  (event) => {
    sounds.unlock();
    if (!state.snapshot?.match?.active || !state.snapshot.you.alive) {
      return;
    }
    const touch = event.touches && event.touches[0];
    if (!touch) {
      return;
    }
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    beginPlanDrag(
      {
        x: touch.clientX - rect.left,
        y: touch.clientY - rect.top
      },
      "touch"
    );
  },
  { passive: false }
);

canvas.addEventListener(
  "touchmove",
  (event) => {
    if (!state.dragPlan.active || state.dragPlan.pointerType !== "touch") {
      return;
    }
    const touch = event.touches && event.touches[0];
    if (!touch) {
      return;
    }
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    updatePlanDrag({
      x: touch.clientX - rect.left,
      y: touch.clientY - rect.top
    });
  },
  { passive: false }
);

canvas.addEventListener(
  "touchend",
  async (event) => {
    if (!state.dragPlan.active || state.dragPlan.pointerType !== "touch") {
      return;
    }
    event.preventDefault();
    await endPlanDrag();
  },
  { passive: false }
);

window.addEventListener("pointermove", (event) => {
  if (!state.snapshot?.match?.active) {
    return;
  }
  if (state.dragPlan.active && state.dragPlan.pointerType === "mouse") {
    const rect = canvas.getBoundingClientRect();
    updatePlanDrag({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top
    });
  }
  if (!state.dragCamera.active) {
    return;
  }
  const dx = (event.clientX - state.dragCamera.startX) / state.camera.zoom;
  const dy = (event.clientY - state.dragCamera.startY) / state.camera.zoom;
  state.camera.x = state.dragCamera.originX - dx;
  state.camera.y = state.dragCamera.originY - dy;
});

window.addEventListener("pointercancel", () => {
  state.dragCamera.active = false;
  state.dragPlan.active = false;
  state.dragPlan.mode = "";
  state.dragPlan.pointerType = "";
});

window.addEventListener("pointerup", async () => {
  state.dragCamera.active = false;
  if (state.dragPlan.active && state.dragPlan.pointerType === "mouse") {
    await endPlanDrag();
  }
});

window.addEventListener("wheel", (event) => {
  if (state.snapshot?.match?.active) {
    event.preventDefault();
  }
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
  if (event.key === "c" || event.key === "C") {
    state.camera.panX = 0;
    state.camera.panY = 0;
    event.preventDefault();
  }
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
    await joinRoom(ui.roomCodeInput.value);
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

window.addEventListener("resize", resizeCanvas);
["gesturestart", "gesturechange", "gestureend"].forEach((eventName) => {
  window.addEventListener(
    eventName,
    (event) => {
      event.preventDefault();
    },
    { passive: false }
  );
});
resizeCanvas();
render();
