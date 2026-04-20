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
  playersLabel: document.getElementById("players-label"),
  startGameButton: document.getElementById("start-game-button"),
  startTestButton: document.getElementById("start-test-button"),
  topActionSlot: document.getElementById("top-action-slot"),
  createBrButton: document.getElementById("create-br-button"),
  killTargetInput: document.getElementById("kill-target-input")
};

const state = {
  token: localStorage.getItem("move-and-shoot-token") || "",
  roomCode: "",
  snapshot: null,
  animationFrame: 0,
  longPollActive: false,
  phaseLocalStartMs: 0,
  phaseDurationMs: null,
  inputStep: "move",
  draftMoveTarget: null,
  draftAimDir: { x: 0, y: -1 },
  messageLog: ["Drag to set your move target, release to commit. Then drag again to aim."],
  lastPhase: "",
  lastRoundSummaryKey: "",
  lastMatchSummaryKey: "",
  lastPlanningKey: "",
  pendingPlanSave: null,
  finalCommitSent: false,
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

const FIXED_VIEW_SHORT_SIDE = 900;
function computeCameraZoom() {
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return shortSide / FIXED_VIEW_SHORT_SIDE;
}
const CAMERA_FOLLOW_SMOOTHING = 0.2;
const CAMERA_BULLET_SMOOTHING = 0.12;

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
  return state.playback.serverStartMs || 0;
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

const NAV_CELL_SIZE = 14;
const navCache = { mapKey: "", nav: null, buildings: null };

function buildingMetrics(building) {
  return {
    x: building.x,
    y: building.y,
    halfWidth: building.width / 2,
    halfHeight: building.height / 2,
    angleRad: (building.angleDeg * Math.PI) / 180
  };
}

function rotateIntoLocalClient(point, building) {
  const dx = point.x - building.x;
  const dy = point.y - building.y;
  const cos = Math.cos(-building.angleRad);
  const sin = Math.sin(-building.angleRad);
  return { x: dx * cos - dy * sin, y: dx * sin + dy * cos };
}

function pointBlockedByBuildingClient(point, radius, buildings) {
  const radiusSq = radius * radius;
  for (const building of buildings) {
    const local = rotateIntoLocalClient(point, building);
    const dx = local.x - clamp(local.x, -building.halfWidth, building.halfWidth);
    const dy = local.y - clamp(local.y, -building.halfHeight, building.halfHeight);
    if (dx * dx + dy * dy < radiusSq) return true;
  }
  return false;
}

function insideWorldClient(point, radius, map) {
  return (
    point.x >= radius &&
    point.x <= map.width - radius &&
    point.y >= radius &&
    point.y <= map.height - radius
  );
}

function segmentClearForCircleClient(start, end, radius, map, buildings) {
  if (!insideWorldClient(end, radius, map) || pointBlockedByBuildingClient(end, radius, buildings)) {
    return false;
  }
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const samples = Math.max(1, Math.ceil(length / Math.max(radius * 0.5, 1)));
  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    const probe = { x: start.x + dx * t, y: start.y + dy * t };
    if (!insideWorldClient(probe, radius, map) || pointBlockedByBuildingClient(probe, radius, buildings)) {
      return false;
    }
  }
  return true;
}

function buildNavGridClient(map, radius) {
  const cellSize = NAV_CELL_SIZE;
  const cols = Math.ceil(map.width / cellSize);
  const rows = Math.ceil(map.height / cellSize);
  const walkable = new Uint8Array(cols * rows);
  const buildings = map.buildings.map((building) => {
    const metrics = buildingMetrics(building);
    const diagonal = Math.hypot(metrics.halfWidth, metrics.halfHeight);
    metrics.boundingRadius = diagonal + radius;
    return metrics;
  });
  for (let cy = 0; cy < rows; cy += 1) {
    const y = cy * cellSize + cellSize / 2;
    for (let cx = 0; cx < cols; cx += 1) {
      const x = cx * cellSize + cellSize / 2;
      const idx = cy * cols + cx;
      if (x < radius || x > map.width - radius || y < radius || y > map.height - radius) {
        continue;
      }
      let blocked = false;
      for (const b of buildings) {
        const ddx = x - b.x;
        const ddy = y - b.y;
        if (ddx * ddx + ddy * ddy > b.boundingRadius * b.boundingRadius) continue;
        const cos = Math.cos(-b.angleRad);
        const sin = Math.sin(-b.angleRad);
        const lx = ddx * cos - ddy * sin;
        const ly = ddx * sin + ddy * cos;
        const cx2 = lx - clamp(lx, -b.halfWidth, b.halfWidth);
        const cy2 = ly - clamp(ly, -b.halfHeight, b.halfHeight);
        if (cx2 * cx2 + cy2 * cy2 < radius * radius) { blocked = true; break; }
      }
      if (!blocked) walkable[idx] = 1;
    }
  }
  return { cellSize, cols, rows, walkable, buildings };
}

function getClientNav(map) {
  const key = map.id || `${map.width}x${map.height}:${map.buildings.length}`;
  if (navCache.mapKey !== key) {
    navCache.mapKey = key;
    navCache.nav = buildNavGridClient(map, state.snapshot.config.playerRadius);
    pathCache.key = "";
    pathCache.path = null;
  }
  return navCache.nav;
}

function nearestWalkableCellClient(nav, point) {
  const cx0 = clamp(Math.floor(point.x / nav.cellSize), 0, nav.cols - 1);
  const cy0 = clamp(Math.floor(point.y / nav.cellSize), 0, nav.rows - 1);
  if (nav.walkable[cy0 * nav.cols + cx0]) return { cx: cx0, cy: cy0 };
  const visited = new Uint8Array(nav.walkable.length);
  visited[cy0 * nav.cols + cx0] = 1;
  let frontier = [[cx0, cy0]];
  for (let ring = 0; ring < 80 && frontier.length; ring += 1) {
    const next = [];
    for (const [x, y] of frontier) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= nav.cols || ny >= nav.rows) continue;
        const key = ny * nav.cols + nx;
        if (visited[key]) continue;
        visited[key] = 1;
        if (nav.walkable[key]) return { cx: nx, cy: ny };
        next.push([nx, ny]);
      }
    }
    frontier = next;
  }
  return null;
}

class ClientMinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) { this.items.push(item); this._up(this.items.length - 1); }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length) { this.items[0] = last; this._down(0); }
    return top;
  }
  _up(i) {
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.items[p][0] <= this.items[i][0]) break;
      const t = this.items[p]; this.items[p] = this.items[i]; this.items[i] = t;
      i = p;
    }
  }
  _down(i) {
    const n = this.items.length;
    while (true) {
      const l = 2 * i + 1, r = 2 * i + 2;
      let b = i;
      if (l < n && this.items[l][0] < this.items[b][0]) b = l;
      if (r < n && this.items[r][0] < this.items[b][0]) b = r;
      if (b === i) break;
      const t = this.items[b]; this.items[b] = this.items[i]; this.items[i] = t;
      i = b;
    }
  }
}

function findPathClient(map, startWorld, endWorld, radius) {
  const nav = getClientNav(map);
  const startCell = nearestWalkableCellClient(nav, startWorld);
  const endCell = nearestWalkableCellClient(nav, endWorld);
  if (!startCell || !endCell) return null;
  const cols = nav.cols;
  const rows = nav.rows;
  const startIdx = startCell.cy * cols + startCell.cx;
  const endIdx = endCell.cy * cols + endCell.cx;
  if (startIdx === endIdx) return [{ x: startWorld.x, y: startWorld.y }, { x: endWorld.x, y: endWorld.y }];

  const gScore = new Float64Array(nav.walkable.length);
  for (let i = 0; i < gScore.length; i += 1) gScore[i] = Infinity;
  gScore[startIdx] = 0;
  const cameFrom = new Int32Array(nav.walkable.length);
  cameFrom.fill(-1);
  const closed = new Uint8Array(nav.walkable.length);

  const heuristic = (cx, cy) => {
    const dx = Math.abs(cx - endCell.cx);
    const dy = Math.abs(cy - endCell.cy);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };

  const heap = new ClientMinHeap();
  heap.push([heuristic(startCell.cx, startCell.cy), startIdx]);
  const dirs = [
    [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
    [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]
  ];

  while (heap.size) {
    const [, curIdx] = heap.pop();
    if (closed[curIdx]) continue;
    closed[curIdx] = 1;
    if (curIdx === endIdx) break;
    const cx = curIdx % cols;
    const cy = (curIdx - cx) / cols;
    const curG = gScore[curIdx];
    for (const [dx, dy, cost] of dirs) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
      const nIdx = ny * cols + nx;
      if (!nav.walkable[nIdx] || closed[nIdx]) continue;
      if (dx !== 0 && dy !== 0) {
        if (!nav.walkable[cy * cols + nx] || !nav.walkable[ny * cols + cx]) continue;
      }
      const tentativeG = curG + cost;
      if (tentativeG < gScore[nIdx]) {
        gScore[nIdx] = tentativeG;
        cameFrom[nIdx] = curIdx;
        heap.push([tentativeG + heuristic(nx, ny), nIdx]);
      }
    }
  }

  if (!closed[endIdx]) return null;

  const rawPath = [];
  let at = endIdx;
  while (at !== -1) {
    const cx = at % cols;
    const cy = (at - cx) / cols;
    rawPath.push({ x: cx * nav.cellSize + nav.cellSize / 2, y: cy * nav.cellSize + nav.cellSize / 2 });
    at = cameFrom[at];
  }
  rawPath.reverse();
  const endIsSafe = insideWorldClient(endWorld, radius, map) && !pointBlockedByBuildingClient(endWorld, radius, nav.buildings);
  const safeEnd = endIsSafe
    ? { x: endWorld.x, y: endWorld.y }
    : rawPath[rawPath.length - 1];
  const fullPath = [{ x: startWorld.x, y: startWorld.y }, ...rawPath, safeEnd];

  const smoothed = [fullPath[0]];
  let anchor = 0;
  for (let i = 2; i < fullPath.length; i += 1) {
    if (!segmentClearForCircleClient(fullPath[anchor], fullPath[i], radius, map, nav.buildings)) {
      smoothed.push(fullPath[i - 1]);
      anchor = i - 1;
    }
  }
  if (segmentClearForCircleClient(smoothed[smoothed.length - 1], fullPath[fullPath.length - 1], radius, map, nav.buildings)) {
    smoothed.push(fullPath[fullPath.length - 1]);
  }
  return smoothed;
}

function clampPathToLengthClient(path, maxLength) {
  if (path.length < 2 || maxLength <= 0) {
    return path.length ? [{ x: path[0].x, y: path[0].y }] : [];
  }
  const result = [{ x: path[0].x, y: path[0].y }];
  let acc = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1], b = path[i];
    const segDist = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + segDist >= maxLength) {
      const remaining = maxLength - acc;
      const t = segDist > 0 ? remaining / segDist : 0;
      result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      return result;
    }
    result.push({ x: b.x, y: b.y });
    acc += segDist;
  }
  return result;
}

const pathCache = { key: "", path: null };

function planPreviewPath(startWorld, endWorld) {
  if (!state.snapshot?.match?.map || !state.snapshot?.config) return null;
  const key = `${navCache.mapKey}|${startWorld.x.toFixed(1)},${startWorld.y.toFixed(1)}|${endWorld.x.toFixed(1)},${endWorld.y.toFixed(1)}`;
  if (pathCache.key === key) return pathCache.path;
  const map = state.snapshot.match.map;
  const radius = state.snapshot.config.playerRadius;
  const full = findPathClient(map, startWorld, endWorld, radius);
  const path = (full && full.length >= 2) ? clampPathToLengthClient(full, state.snapshot.config.moveRange) : null;
  pathCache.key = key;
  pathCache.path = path;
  return path;
}

function byId(id) {
  return state.snapshot?.players.find((entry) => entry.id === id) || null;
}

function getPhaseTimeRemaining() {
  if (!state.phaseLocalStartMs || !state.phaseDurationMs) {
    return null;
  }
  return Math.max(0, state.phaseLocalStartMs + state.phaseDurationMs - performance.now());
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
  return state.snapshot.players.filter((player) => {
    if (player.disconnected) {
      return false;
    }
    return player.visibleToYou || player.id === state.snapshot.you.id;
  });
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
      const cameraLeadMs = 40;
      const clampedElapsed = clamp(elapsed + cameraLeadMs, 0, localBullet.stopTimeMs + cameraLeadMs);
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
    state.camera.zoom = computeCameraZoom();
  }
  if (state.snapshot.you.alive) {
    const target = getCameraTarget();
    const localShotBullet = getLocalShotBullet();
    state.camera.zoom = computeCameraZoom();
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
    state.camera.zoom = computeCameraZoom();
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

async function joinRoom(roomCode, options = {}) {
  const name = ui.playerNameInput.value.trim().slice(0, 20);
  const payload = roomCode ? { roomCode } : {};
  if (name) {
    payload.name = name;
  }
  payload.mapGridSize = Number(ui.mapSizeInput.value) || 2;
  if (options.mode === "br") {
    payload.mode = "br";
    payload.killTarget = Number(ui.killTargetInput.value) || 5;
  }
  const result = await api("/api/join", { method: "POST", body: payload });
  state.token = result.token;
  state.roomCode = result.roomCode;
  if (result.roomCode === "H3LP") {
    alert("Ruby's belly");
  }
  localStorage.setItem("move-and-shoot-token", result.token);
  ui.roomCodeInput.value = result.roomCode;
  ui.menu.classList.add("hidden");
  ui.hud.classList.remove("hidden");
  pushMessage(`Joined room ${result.roomCode} as ${result.name}.`);
  startPolling();
}

async function startPolling() {
  if (state.longPollActive) return;
  state.longPollActive = true;
  let lastVersion = -1;
  while (state.token) {
    try {
      const suffix = lastVersion >= 0 ? `&version=${lastVersion}` : "";
      const snapshot = await api(`/api/state?token=${encodeURIComponent(state.token)}${suffix}`);
      lastVersion = typeof snapshot.version === "number" ? snapshot.version : lastVersion;
      handleSnapshot(snapshot);
    } catch (error) {
      ui.menu.classList.remove("hidden");
      ui.hud.classList.add("hidden");
      ui.menuMessage.textContent = error.message;
      state.longPollActive = false;
      return;
    }
  }
  state.longPollActive = false;
}

function sameSummaryKey(summary) {
  return JSON.stringify(summary || null);
}

function handleSnapshot(snapshot) {
  const previous = state.snapshot;
  state.snapshot = snapshot;
  state.roomCode = snapshot.room.code;
  if (snapshot.match?.map && snapshot.config) {
    const key = snapshot.match.map.id || `${snapshot.match.map.width}x${snapshot.match.map.height}:${snapshot.match.map.buildings.length}`;
    if (navCache.mapKey !== key) {
      navCache.mapKey = key;
      navCache.nav = buildNavGridClient(snapshot.match.map, snapshot.config.playerRadius);
      pathCache.key = "";
      pathCache.path = null;
    }
  }
  const planningKey = snapshot.match.active
    ? `${snapshot.match.currentRound}-${snapshot.match.turnNumber}-${snapshot.room.phase}`
    : snapshot.room.phase;

  if (snapshot.room.phase !== state.lastPhase) {
    state.phaseLocalStartMs = performance.now();
    state.phaseDurationMs = snapshot.room.phaseDurationMs || null;
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
    if (snapshot.room.phase === "shooting" && snapshot.match?.shooting?.bullets?.length) {
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
    state.finalCommitSent = false;
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
  ui.timerLabel.textContent = state.snapshot.room.phase === "planning"
    ? formatSeconds(getPhaseTimeRemaining())
    : "—";
  ui.roundLabel.textContent = state.snapshot.match.active
    ? `${state.snapshot.match.currentRound} / ${state.snapshot.match.totalRounds}`
    : "- / 3";
  ui.turnLabel.textContent = state.snapshot.match.active
    ? String(state.snapshot.match.turnNumber || "-")
    : "-";
  ui.readyLabel.textContent = state.draftMoveTarget && state.snapshot.room.phase === "planning"
    ? "Plan set"
    : state.snapshot.you.alive
      ? "Planning"
      : "Spectating";
  const leaderWins = Math.max(0, ...state.snapshot.players.map((player) => player.wins || 0));
  const isBr = state.snapshot.room.mode === "br";
  if (isBr) {
    const myKills = state.snapshot.match?.kills?.[state.snapshot.you.id] ?? 0;
    const topKills = Math.max(0, ...Object.values(state.snapshot.match?.kills || { _: 0 }));
    ui.scoreLabel.textContent = `${myKills}K / ${topKills}K`;
  } else {
    ui.scoreLabel.textContent = `${state.snapshot.you.wins || 0}W / ${leaderWins}W`;
  }
  const connectedPlayers = state.snapshot.players.filter((player) => player.connected);
  const rosterNames = connectedPlayers.map((player) => player.name).join(", ") || "—";
  ui.playersLabel.textContent = `${connectedPlayers.length}/${state.snapshot.room.maxPlayers}: ${rosterNames}`;
  ui.topActionSlot.classList.toggle(
    "hidden",
    isBr || !(state.snapshot.you.isHost && state.snapshot.room.phase === "lobby")
  );
  if (!isBr) {
    ui.startGameButton.disabled = state.snapshot.room.connectedCount < state.snapshot.room.minPlayers;
    ui.startGameButton.textContent =
      state.snapshot.room.connectedCount < state.snapshot.room.minPlayers
        ? "Need 2 Players"
        : "Start Game";
  }
  const showRespawn = isBr && state.snapshot.match?.active && !state.snapshot.you.alive;
  ui.respawnSlot.classList.toggle("hidden", !showRespawn);
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
    const path = planPreviewPath(start, moveTarget) || [start, moveTarget];
    ctx.strokeStyle = "rgba(45, 106, 79, 0.92)";
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    const first = worldToScreen(path[0]);
    ctx.moveTo(first.x, first.y);
    for (let i = 1; i < path.length; i += 1) {
      const p = worldToScreen(path[i]);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);

    const pathEnd = path[path.length - 1];
    const endScreen = worldToScreen(pathEnd);
    ctx.fillStyle = "rgba(45, 106, 79, 0.85)";
    ctx.beginPath();
    ctx.arc(endScreen.x, endScreen.y, 6, 0, Math.PI * 2);
    ctx.fill();

    const aimEnd = {
      x: pathEnd.x + aimDir.x * 260,
      y: pathEnd.y + aimDir.y * 260
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
      state.inputStep === "move" ? "Drag to set move target" : "Drag to set aim direction",
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
  renderHud();
  checkPlanningTimeout();
  state.animationFrame = requestAnimationFrame(render);
}

function checkPlanningTimeout() {
  if (!state.snapshot || state.snapshot.room.phase !== "planning") return;
  const remaining = getPhaseTimeRemaining();
  if (remaining === null || remaining > 0 || state.finalCommitSent) return;
  state.finalCommitSent = true;
  if (state.dragPlan.active) {
    endPlanDrag();
  }
  forceCommitCurrentDraft();
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
  const delta = { x: world.x - origin.x, y: world.y - origin.y };
  if (Math.hypot(delta.x, delta.y) < 4) {
    return true;
  }
  state.draftAimDir = normalize(delta, state.snapshot.you.lastAimDir);
  return true;
}

function commitCurrentDraft(mode) {
  if (!state.snapshot?.you.alive || state.snapshot.room.phase !== "planning") {
    return;
  }
  if (mode === "move") {
    state.inputStep = "aim";
    pushMessage("Move target set. Drag to aim.");
  } else {
    state.inputStep = "move";
    pushMessage("Aim set.");
  }
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

async function forceCommitCurrentDraft() {
  if (!state.snapshot?.you.alive || state.snapshot.room.phase !== "planning") return;
  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  const moveTarget =
    state.draftMoveTarget ||
    state.snapshot.planning?.plan?.moveTarget ||
    { x: you.x, y: you.y };
  const aimDir =
    state.draftAimDir ||
    state.snapshot.planning?.plan?.aimDir ||
    state.snapshot.you.lastAimDir ||
    { x: 0, y: -1 };
  try {
    await savePlan({ moveTarget, aimDir, final: true });
  } catch (error) {
    // silent — best-effort end-of-phase commit
  }
}

function endPlanDrag() {
  if (!state.dragPlan.active) {
    return;
  }
  const mode = state.dragPlan.mode;
  state.dragPlan.active = false;
  state.dragPlan.mode = "";
  state.dragPlan.pointerType = "";
  commitCurrentDraft(mode);
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
      aimDir: plan.aimDir,
      final: !!plan.final
    }
  });
}

async function startGame(options = {}) {
  if (!state.token) {
    return;
  }
  await api("/api/start", {
    method: "POST",
    body: {
      token: state.token,
      testMode: !!options.testMode
    }
  });
}

function clampMoveTarget(worldPoint) {
  if (!state.snapshot?.match?.map) {
    return { x: worldPoint.x, y: worldPoint.y };
  }
  const map = state.snapshot.match.map;
  const radius = state.snapshot.config.playerRadius;
  return {
    x: clamp(worldPoint.x, radius, map.width - radius),
    y: clamp(worldPoint.y, radius, map.height - radius)
  };
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

canvas.addEventListener(
  "touchcancel",
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

window.addEventListener("pointercancel", async () => {
  state.dragCamera.active = false;
  if (state.dragPlan.active) {
    await endPlanDrag();
  }
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

ui.createBrButton.addEventListener("click", async () => {
  sounds.unlock();
  ui.menuMessage.textContent = "Creating battle royale...";
  try {
    await joinRoom(ui.roomCodeInput.value, { mode: "br" });
  } catch (error) {
    ui.menuMessage.textContent = error.message;
  }
});

ui.respawnButton.addEventListener("click", async () => {
  sounds.unlock();
  try {
    await api("/api/respawn", { method: "POST", body: { token: state.token } });
  } catch (error) {
    pushMessage(error.message);
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

ui.startTestButton.addEventListener("click", async () => {
  sounds.unlock();
  try {
    await startGame({ testMode: true });
    pushMessage("Test mode (1P) starting...");
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
