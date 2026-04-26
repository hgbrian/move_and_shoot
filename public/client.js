const canvas = document.getElementById("game-canvas");
const ctx = canvas.getContext("2d");

const UI_ELEMENTS = {
  menu: "menu",
  hud: "hud",
  playerNameInput: "player-name-input",
  hatColorInput: "hat-color-input",
  hatColor2Input: "hat-color-2-input",
  modeInput: "mode-input",
  mapSizeInput: "map-size-input",
  totalRoundsInput: "total-rounds-input",
  botCountInput: "bot-count-input",
  lineOfSightInput: "line-of-sight-input",
  roomCodeInput: "room-code-input",
  createRoomButton: "create-room-button",
  joinRoomButton: "join-room-button",
  menuMessage: "menu-message",
  roomCodeLabel: "room-code-label",
  phaseLabel: "phase-label",
  timerLabel: "timer-label",
  roundLabelTitle: "round-label-title",
  roundLabel: "round-label",
  turnLabel: "turn-label",
  readyLabel: "ready-label",
  scoreLabel: "score-label",
  playersLabel: "players-label",
  startGameButton: "start-game-button",
  startTestButton: "start-test-button",
  addBotButton: "add-bot-button",
  topActionSlot: "top-action-slot",
  createBrButton: "create-br-button",
  createBrBotsButton: "create-br-bots-button",
  scoreTile: "score-tile",
  leaderboard: "leaderboard",
  leaderboardList: "leaderboard-list",
  phaseBanner: "phase-banner",
  phaseBannerText: "phase-banner-text",
  phaseBannerFill: "phase-banner-fill"
};

const ui = Object.fromEntries(
  Object.entries(UI_ELEMENTS).map(([key, id]) => [key, document.getElementById(id)])
);

for (const [key, el] of Object.entries(ui)) {
  if (!el) console.warn(`[ui] missing element for "${key}" (id="${UI_ELEMENTS[key]}")`);
}

function bind(el, event, handler, opts) {
  if (!el) {
    console.warn(`[bind] missing element for ${event} handler`);
    return;
  }
  el.addEventListener(event, handler, opts);
}

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
  },
  seenKillNoticeKeys: new Set(),
  killNoticeQueue: [],
  deathNotice: null,
  deathNoticeKey: ""
};

const FIXED_VIEW_SHORT_SIDE = 900;
function computeCameraZoom() {
  const shortSide = Math.min(window.innerWidth, window.innerHeight);
  return shortSide / FIXED_VIEW_SHORT_SIDE;
}
const CAMERA_FOLLOW_SMOOTHING = 0.2;
const CAMERA_BULLET_SMOOTHING = 0.12;
const SHOOTING_ZOOM_MULTIPLIER = 0.82;

function targetCameraZoom() {
  const base = computeCameraZoom();
  return state.snapshot?.room?.phase === "shooting"
    ? base * SHOOTING_ZOOM_MULTIPLIER
    : base;
}

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
    this.tone(260, 0.055, "sine", 0.018);
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

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

function isDeathmatchMode(mode) {
  return mode === "br" || mode === "ffa" || mode === "team" || mode === "coins";
}

function isTeamMode(mode) {
  return mode === "team" || mode === "coins";
}

function isCoinMode(mode) {
  return mode === "coins";
}

function teamLabel(team) {
  return team === "blue" ? "Blue" : "Red";
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

const NAV_CELL_SIZE = 14;
const MAX_NAV_CELLS = 160000;
const navCache = { mapKey: "", nav: null, buildings: null };

function navCellSizeForMap(map) {
  const area = Math.max(1, map.width * map.height);
  return Math.max(NAV_CELL_SIZE, Math.ceil(Math.sqrt(area / MAX_NAV_CELLS)));
}

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
  const cellSize = navCellSizeForMap(map);
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

function mapFingerprint(map) {
  let hash = `${map.id || ""}:${map.width}x${map.height}:${map.buildings.length}`;
  for (const b of map.buildings) {
    hash += `|${b.x.toFixed(1)},${b.y.toFixed(1)},${b.width.toFixed(1)},${b.height.toFixed(1)},${b.angleDeg}`;
  }
  return hash;
}

function getClientNav(map) {
  const key = mapFingerprint(map);
  if (navCache.mapKey !== key) {
    console.log("[nav] rebuilding grid", { buildings: map.buildings.length, mapId: map.id });
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

function lineOfSightClearClient(a, b, buildings) {
  if (!buildings) return true;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length < 1) return true;
  const stepCount = Math.max(2, Math.ceil(length / 12));
  for (let i = 1; i < stepCount; i += 1) {
    const t = i / stepCount;
    const px = a.x + dx * t;
    const py = a.y + dy * t;
    for (const building of buildings) {
      const ddx = px - building.x;
      const ddy = py - building.y;
      const reach = building.boundingRadius || (Math.hypot(building.halfWidth, building.halfHeight) + 6);
      if (ddx * ddx + ddy * ddy > reach * reach) continue;
      const cos = Math.cos(-building.angleRad);
      const sin = Math.sin(-building.angleRad);
      const lx = ddx * cos - ddy * sin;
      const ly = ddx * sin + ddy * cos;
      if (Math.abs(lx) < building.halfWidth && Math.abs(ly) < building.halfHeight) {
        return false;
      }
    }
  }
  return true;
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
  if (!state.snapshot?.match?.active || !state.snapshot.match.map) {
    return { x: player.x, y: player.y };
  }

  const movement = state.snapshot.match.movement;
  if (!movement?.byPlayer) {
    return { x: player.x, y: player.y };
  }

  const entry = movement.byPlayer[player.id];
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
  if (!state.snapshot) return { x: 0, y: 0 };
  const you = byId(state.snapshot.you.id) || state.snapshot.you;
  if (state.snapshot.room.phase === "shooting") {
    const localBullet = getLocalShotBullet();
    if (localBullet) {
      const shooting = state.snapshot.match.shooting;
      const elapsed = currentPlaybackServerNow() - shooting.startedAt;
      const localElapsed = elapsed - localBullet.fireTimeMs;
      if (localElapsed >= 0) {
        const bulletSpeedPxMs = state.snapshot.config.bulletSpeed / 1000;
        const head = bulletStateAtTime(localBullet, localElapsed + 40, bulletSpeedPxMs);
        if (head) return { x: head.x, y: head.y };
      }
    }
  }
  if (state.snapshot.you.alive) {
    return getAnimatedPlayerPosition(you);
  }
  return { x: state.camera.x, y: state.camera.y };
}

function getLocalShotBullet() {
  if (!state.snapshot || state.snapshot.room.phase !== "shooting") return null;
  const shooting = state.snapshot.match?.shooting;
  if (!shooting?.bullets?.length) return null;
  const elapsed = currentPlaybackServerNow() - shooting.startedAt;
  const own = shooting.bullets.find((b) => b.shooterId === state.snapshot.you.id);
  if (!own) return null;
  if (elapsed < own.fireTimeMs) return null;
  return own;
}

function ensureCamera() {
  if (!state.snapshot?.match?.map) {
    state.camera.x = 0;
    state.camera.y = 0;
    return;
  }

  const map = state.snapshot.match.map;
  if (!state.camera.zoom) {
    state.camera.zoom = targetCameraZoom();
  }
  state.camera.zoom = lerp(state.camera.zoom, targetCameraZoom(), 0.12);
  const localShotBullet = getLocalShotBullet();
  if (state.snapshot.you.alive || localShotBullet) {
    const target = localShotBullet ? getCameraTarget() : getCameraTarget();
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
      const err = new Error(json.error || "Request failed");
      err.status = response.status;
      throw err;
    }
    return json;
  });
}

async function joinRoom(roomCode, options = {}) {
  const name = ui.playerNameInput.value.trim().slice(0, 20);
  const selectedMode = options.mode || ui.modeInput.value || "team";
  const payload = roomCode ? { roomCode } : {};
  if (name) {
    payload.name = name;
  }
  payload.hatColor = ui.hatColorInput.value;
  payload.hatColor2 = ui.hatColor2Input.value;
  payload.mapGridSize = Number(ui.mapSizeInput.value) || 2;
  if (!roomCode) {
    payload.lineOfSight = !!ui.lineOfSightInput.checked;
    payload.mode = selectedMode;
    payload.createNew = !!options.createNew;
    payload.private = selectedMode !== "br";
    if (options.fillBots) {
      payload.fillBots = true;
    }
  }
  const requestedBots = !roomCode
    ? clamp(Math.floor(Number(ui.botCountInput.value) || 0), 0, 49)
    : 0;
  const firstTo = Number(ui.totalRoundsInput.value) || 5;
  if (requestedBots > 0) {
    payload.bots = requestedBots;
    if (selectedMode !== "br" && selectedMode !== "coins") {
      payload.killTarget = firstTo;
    }
  }
  if (!roomCode && selectedMode !== "br" && selectedMode !== "coins") {
    payload.killTarget = firstTo;
  }
  const result = await api("/api/join", { method: "POST", body: payload });
  state.token = result.token;
  state.roomCode = result.roomCode;
  if (result.roomCode === "H3LP") {
    alert("Ruby's belly");
  }
  localStorage.setItem("move-and-shoot-token", result.token);
  ui.roomCodeInput.value = selectedMode === "br" ? "" : result.roomCode;
  ui.menu.classList.add("hidden");
  ui.hud.classList.remove("hidden");
  pushMessage(
    selectedMode === "br"
      ? `Joined Battle Royale as ${result.name}.`
      : `Joined room ${result.roomCode} as ${result.name}.`
  );
  startPolling();
}

async function startPolling() {
  if (state.longPollActive) return;
  state.longPollActive = true;
  let lastVersion = -1;
  let retryDelay = 500;
  while (state.token) {
    try {
      const suffix = lastVersion >= 0 ? `&version=${lastVersion}` : "";
      const snapshot = await api(`/api/state?token=${encodeURIComponent(state.token)}${suffix}`);
      lastVersion = typeof snapshot.version === "number" ? snapshot.version : lastVersion;
      retryDelay = 500;
      handleSnapshot(snapshot);
    } catch (error) {
      if (error.status === 401) {
        localStorage.removeItem("move-and-shoot-token");
        state.token = "";
        ui.menu.classList.remove("hidden");
        ui.hud.classList.add("hidden");
        ui.menuMessage.textContent = "Session expired. Rejoin to continue.";
        state.longPollActive = false;
        return;
      }
      console.warn("[poll] transient error, retrying:", error.message);
      pushMessage(`Reconnecting… (${error.message})`);
      await new Promise((r) => setTimeout(r, retryDelay));
      retryDelay = Math.min(retryDelay * 2, 5000);
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
    const key = mapFingerprint(snapshot.match.map);
    if (navCache.mapKey !== key) {
      console.log("[nav] rebuilding grid (handleSnapshot)", { buildings: snapshot.match.map.buildings.length, mapId: snapshot.match.map.id });
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
    } else {
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
    if (snapshot.summaries.match.winnerTeam) {
      pushMessage(`${teamLabel(snapshot.summaries.match.winnerTeam)} Team wins the battle.`);
    } else if (snapshot.summaries.match.winnerId) {
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
    state.planLocked = false;
  }

  if (previous && previous.players && snapshot.players) {
    snapshot.players.forEach((player) => {
      const older = previous.players.find((entry) => entry.id === player.id);
      if (older && older.alive && !player.alive && snapshot.match.active) {
        sounds.hit();
        if (player.id === snapshot.you.id) {
          sounds.death();
          triggerDeathNoticeFromSnapshot(snapshot, "state-change");
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
  const isBr = state.snapshot.room.mode === "br";
  const isCoins = isCoinMode(state.snapshot.room.mode);
  ui.roomCodeLabel.textContent = isBr ? "Battle Royale" : state.snapshot.room.code;
  ui.phaseLabel.textContent = state.snapshot.room.phaseLabel;
  const coinRemaining = state.snapshot.match?.roundStartedAt
    ? Math.max(0, state.snapshot.match.roundStartedAt + (state.snapshot.config.coinRoundMs || 180000) - state.snapshot.serverNow)
    : null;
  ui.timerLabel.textContent = isCoins && coinRemaining !== null
    ? formatSeconds(coinRemaining)
    : state.snapshot.room.phase === "planning"
    ? formatSeconds(getPhaseTimeRemaining())
    : "—";
  const isDeathmatch = isDeathmatchMode(state.snapshot.room.mode);
  const isTeam = isTeamMode(state.snapshot.room.mode);
  ui.roundLabelTitle.textContent = isBr ? "Mode" : (isCoins ? "Mode" : (isDeathmatch ? "Target" : "Round"));
  ui.roundLabel.textContent = state.snapshot.match.active
    ? isBr
      ? "Endless"
      : isCoins
      ? "Coin Runners"
      : isDeathmatch
      ? `First to ${state.snapshot.room.settings.killTarget || 5}`
      : state.snapshot.match.totalRounds
        ? `${state.snapshot.match.currentRound} / ${state.snapshot.match.totalRounds}`
        : `${state.snapshot.match.currentRound}`
    : "—";
  ui.turnLabel.textContent = state.snapshot.match.active
    ? String(state.snapshot.match.turnNumber || "-")
    : "-";
  ui.readyLabel.textContent = state.draftMoveTarget && state.snapshot.room.phase === "planning"
    ? "Plan set"
    : state.snapshot.you.alive
      ? "Planning"
      : "Spectating";
  const leaderWins = Math.max(0, ...state.snapshot.players.map((player) => player.wins || 0));
  const showLobbyActions = state.snapshot.you.isHost && state.snapshot.room.phase === "lobby";
  if (isCoins) {
    const teamCoins = state.snapshot.match?.teamCoins || {};
    const red = teamCoins.red ?? 0;
    const blue = teamCoins.blue ?? 0;
    ui.scoreLabel.textContent = `Red ${red} coins · Blue ${blue} coins`;
  } else if (isTeam) {
    const teamKills = state.snapshot.match?.teamKills || {};
    const red = teamKills.red ?? 0;
    const blue = teamKills.blue ?? 0;
    ui.scoreLabel.textContent = `Red ${red} · Blue ${blue}`;
  } else if (isDeathmatch) {
    const kills = state.snapshot.match?.kills || {};
    const myKills = kills[state.snapshot.you.id] ?? 0;
    const better = Object.values(kills).filter((k) => k > myKills).length;
    ui.scoreLabel.textContent = `${myKills}K · ${ordinal(better + 1)}`;
  } else {
    ui.scoreLabel.textContent = `${state.snapshot.you.wins || 0}W / ${leaderWins}W`;
  }
  const connectedPlayers = state.snapshot.players.filter((player) => player.connected);
  const rosterNames = connectedPlayers.map((player) => player.name).join(", ") || "—";
  const maxPlayers = state.snapshot.room.maxPlayers === null ? "∞" : state.snapshot.room.maxPlayers;
  ui.playersLabel.textContent = `${connectedPlayers.length}/${maxPlayers}: ${rosterNames}`;
  ui.topActionSlot.classList.toggle("hidden", !showLobbyActions);
  ui.startTestButton.classList.add("hidden");
  ui.addBotButton.classList.toggle("hidden", !isDeathmatch);
  if (showLobbyActions) {
    ui.startGameButton.disabled = state.snapshot.room.connectedCount < state.snapshot.room.minPlayers;
    ui.startGameButton.textContent =
      state.snapshot.room.connectedCount < state.snapshot.room.minPlayers
        ? `Need ${state.snapshot.room.minPlayers} Player${state.snapshot.room.minPlayers === 1 ? "" : "s"}`
        : isDeathmatch
          ? "Start Battle"
          : "Start Game";
  }
  renderLeaderboard();
}

function drawBackground(map, viewport) {
  ctx.fillStyle = currentMapBgColor();
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

function drawCoins(map) {
  const coins = map.coins || [];
  if (!coins.length) return;
  const radius = (state.snapshot.config.coinRadius || 10) * state.camera.zoom;
  for (const coin of coins) {
    const screen = worldToScreen(coin);
    ctx.save();
    ctx.translate(screen.x, screen.y);
    ctx.fillStyle = "#f6c945";
    ctx.strokeStyle = "rgba(91, 58, 12, 0.75)";
    ctx.lineWidth = Math.max(1, radius * 0.18);
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = "rgba(255, 250, 207, 0.85)";
    ctx.beginPath();
    ctx.arc(-radius * 0.28, -radius * 0.28, radius * 0.24, 0, Math.PI * 2);
    ctx.fill();
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

function bulletStateAtTime(bullet, localElapsedMs, bulletSpeedPxMs) {
  if (!bullet.segments || !bullet.segments.length) return null;
  const stopMs = bullet.stopTimeMs;
  const tMs = Math.min(Math.max(localElapsedMs, 0), stopMs);
  for (const seg of bullet.segments) {
    const segDurationMs = seg.distance / bulletSpeedPxMs;
    const startMs = seg.startTimeMs;
    if (tMs <= startMs + segDurationMs) {
      const dtIn = Math.max(0, tMs - startMs);
      const distIn = dtIn * bulletSpeedPxMs;
      return {
        x: seg.origin.x + seg.direction.x * distIn,
        y: seg.origin.y + seg.direction.y * distIn,
        direction: seg.direction
      };
    }
  }
  const last = bullet.segments[bullet.segments.length - 1];
  return {
    x: last.origin.x + last.direction.x * last.distance,
    y: last.origin.y + last.direction.y * last.distance,
    direction: last.direction
  };
}

function drawBullets() {
  const shooting = state.snapshot?.match?.shooting;
  if (!shooting || state.snapshot.room.phase !== "shooting") return;
  const bullets = shooting.bullets || [];
  if (!bullets.length) return;
  const elapsed = currentPlaybackServerNow() - shooting.startedAt;
  const bulletSpeedPxMs = state.snapshot.config.bulletSpeed / 1000;
  const bulletRadius = (state.snapshot.config.bulletRadius || 6) * state.camera.zoom;

  bullets.forEach((bullet) => {
    const localElapsed = elapsed - bullet.fireTimeMs;
    if (localElapsed < 0) return;
    const head = bulletStateAtTime(bullet, localElapsed, bulletSpeedPxMs);
    if (!head) return;
    const tail = {
      x: head.x - head.direction.x * 28,
      y: head.y - head.direction.y * 28
    };
    const headScr = worldToScreen(head);
    const tailScr = worldToScreen(tail);
    ctx.lineCap = "round";
    ctx.strokeStyle = bullet.color || "rgba(28, 16, 8, 0.95)";
    ctx.lineWidth = Math.max(2, bulletRadius * 0.55);
    ctx.beginPath();
    ctx.moveTo(tailScr.x, tailScr.y);
    ctx.lineTo(headScr.x, headScr.y);
    ctx.stroke();
    ctx.strokeStyle = "rgba(255, 244, 220, 0.55)";
    ctx.lineWidth = Math.max(0.8, bulletRadius * 0.18);
    ctx.beginPath();
    ctx.moveTo(tailScr.x, tailScr.y);
    ctx.lineTo(headScr.x, headScr.y);
    ctx.stroke();
    if (localElapsed >= bullet.stopTimeMs) {
      const sinceStop = Math.min(localElapsed - bullet.stopTimeMs, 500);
      const t = sinceStop / 500;
      const r = bulletRadius * (1 + t * 3);
      ctx.strokeStyle = `rgba(180, 50, 30, ${1 - t})`;
      ctx.lineWidth = 2 * (1 - t);
      ctx.beginPath();
      ctx.arc(headScr.x, headScr.y, r, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

function getDrawAimDir(player) {
  const baseAim = player.lastAimDir || { x: 0, y: -1 };
  if (!state.snapshot || state.snapshot.room.phase !== "movement") return baseAim;
  const movement = state.snapshot.match?.movement;
  if (!movement) return baseAim;
  const entry = movement.byPlayer?.[player.id];
  if (!entry || !entry.samples || entry.samples.length < 2) return baseAim;
  const samples = entry.samples;
  const start = samples[0];
  const end = samples[samples.length - 1];
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy);
  if (len < 4) return baseAim;
  const moveDir = { x: dx / len, y: dy / len };
  const moveAngle = Math.atan2(moveDir.y, moveDir.x);
  const aimAngle = Math.atan2(baseAim.y, baseAim.x);
  let delta = aimAngle - moveAngle;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const movementMs = state.snapshot.config.movementMs || 2000;
  const elapsed = currentPlaybackServerNow() - movement.startedAt;
  const t = clamp(elapsed / movementMs, 0, 1);
  const eased = t * t * (3 - 2 * t);
  const blended = moveAngle + delta * eased;
  return { x: Math.cos(blended), y: Math.sin(blended) };
}

function isAliveDuringPlayback(player) {
  if (player.alive) return true;
  if (state.snapshot.room.phase !== "shooting") return false;
  const shooting = state.snapshot.match?.shooting;
  const entry = shooting?.byPlayer?.[player.id];
  if (!entry || entry.diedAtMs === null || entry.diedAtMs === undefined) return false;
  const elapsed = currentPlaybackServerNow() - shooting.startedAt;
  return elapsed < entry.diedAtMs;
}

function drawPlayer(player) {
  const position = getAnimatedPlayerPosition(player);
  const lineOfSightEnabled = state.snapshot.room.settings.lineOfSight !== false;
  if (lineOfSightEnabled && player.id !== state.snapshot.you.id && state.snapshot.you.alive) {
    const me = byId(state.snapshot.you.id) || state.snapshot.you;
    const myPos = getAnimatedPlayerPosition(me);
    const buildings = navCache.nav?.buildings;
    if (!lineOfSightClearClient(myPos, position, buildings)) return;
  }
  const screen = worldToScreen(position);
  const radius = state.snapshot.config.playerRadius * state.camera.zoom;
  const alive = isAliveDuringPlayback(player);
  const brimRadius = radius;
  const crownRadius = radius * 0.55;
  const aimDir = getDrawAimDir(player);
  const aimPerp = { x: -aimDir.y, y: aimDir.x };

  ctx.save();
  ctx.translate(screen.x, screen.y);

  ctx.fillStyle = alive ? "rgba(45, 28, 14, 0.62)" : "rgba(60, 60, 60, 0.28)";
  ctx.beginPath();
  ctx.arc(0, 0, brimRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "rgba(33, 18, 9, 0.55)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(0, 0, brimRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = "rgba(33, 18, 9, 0.18)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(0, 0, brimRadius * 0.78, 0, Math.PI * 2);
  ctx.stroke();

  const gunStart = {
    x: aimDir.x * (crownRadius * 0.45),
    y: aimDir.y * (crownRadius * 0.45)
  };
  const gunEnd = {
    x: aimDir.x * (brimRadius * 1.18),
    y: aimDir.y * (brimRadius * 1.18)
  };
  ctx.strokeStyle = alive ? "rgba(28, 16, 8, 0.95)" : "rgba(33,18,9,0.3)";
  ctx.lineWidth = 4.5;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(gunStart.x, gunStart.y);
  ctx.lineTo(gunEnd.x, gunEnd.y);
  ctx.stroke();
  ctx.strokeStyle = alive ? "rgba(255, 244, 230, 0.45)" : "rgba(255,255,255,0.12)";
  ctx.lineWidth = 1.25;
  ctx.beginPath();
  ctx.moveTo(gunStart.x, gunStart.y);
  ctx.lineTo(gunEnd.x, gunEnd.y);
  ctx.stroke();
  ctx.strokeStyle = alive ? "rgba(28, 16, 8, 0.85)" : "rgba(33,18,9,0.22)";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.moveTo(
    -aimDir.x * (crownRadius * 0.2) - aimPerp.x * (crownRadius * 0.34),
    -aimDir.y * (crownRadius * 0.2) - aimPerp.y * (crownRadius * 0.34)
  );
  ctx.lineTo(
    -aimDir.x * (crownRadius * 0.2) + aimPerp.x * (crownRadius * 0.34),
    -aimDir.y * (crownRadius * 0.2) + aimPerp.y * (crownRadius * 0.34)
  );
  ctx.stroke();

  ctx.fillStyle = "rgba(33, 18, 9, 0.6)";
  ctx.beginPath();
  ctx.arc(0, 0, crownRadius * 1.08, 0, Math.PI * 2);
  ctx.fill();

  const hatBase = alive ? player.color : "rgba(110, 110, 110, 0.5)";
  const hatAccent = alive ? (player.color2 || player.color) : "rgba(150, 150, 150, 0.42)";
  ctx.fillStyle = hatBase;
  ctx.beginPath();
  ctx.arc(0, 0, crownRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = hatAccent;
  ctx.beginPath();
  ctx.ellipse(0, crownRadius * 0.05, crownRadius * 0.92, crownRadius * 0.22, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = hatAccent;
  ctx.lineWidth = Math.max(1, crownRadius * 0.14);
  ctx.beginPath();
  ctx.arc(0, 0, crownRadius * 0.73, Math.PI * 0.08, Math.PI * 0.92);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 248, 232, 0.55)";
  for (let i = -2; i <= 2; i += 1) {
    ctx.beginPath();
    ctx.arc(i * crownRadius * 0.32, crownRadius * 0.05, crownRadius * 0.055, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.strokeStyle = "rgba(255, 248, 232, 0.28)";
  ctx.lineWidth = 1.2;
  ctx.beginPath();
  ctx.arc(-crownRadius * 0.18, -crownRadius * 0.22, crownRadius * 0.55, Math.PI * 0.85, Math.PI * 1.5);
  ctx.stroke();

  ctx.strokeStyle = "rgba(33, 18, 9, 0.7)";
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, crownRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = "rgba(33, 18, 9, 0.8)";
  ctx.beginPath();
  ctx.arc(0, 0, crownRadius * 0.16, 0, Math.PI * 2);
  ctx.fill();

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
  const shootingEntries = state.snapshot?.match?.shooting?.byPlayer || {};
  Object.keys(shootingEntries).forEach((playerId) => {
    const player = byId(playerId) || { id: playerId };
    drawDeathBurst(player);
  });
}

function drawDeathBurst(player) {
  if (state.snapshot.room.phase !== "shooting") return;
  const shooting = state.snapshot.match?.shooting;
  const entry = shooting?.byPlayer?.[player.id];
  if (!entry || entry.diedAtMs === null || entry.diedAtMs === undefined) return;
  const elapsed = currentPlaybackServerNow() - shooting.startedAt;
  const burstMs = 700;
  const sinceDeath = elapsed - entry.diedAtMs;
  if (sinceDeath < 0 || sinceDeath > burstMs) return;

  const deathPos = entry.pos || { x: player.x, y: player.y };
  const screen = worldToScreen(deathPos);
  const t = clamp(sinceDeath / burstMs, 0, 1);
  const ease = 1 - (1 - t) * (1 - t);
  const alpha = 1 - t;
  const zoom = state.camera.zoom;
  const baseRadius = state.snapshot.config.playerRadius * zoom;

  const ringRadius = baseRadius * (1 + ease * 4);
  ctx.strokeStyle = `rgba(180, 50, 30, ${alpha})`;
  ctx.lineWidth = 8 * (1 - t * 0.6);
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, ringRadius, 0, Math.PI * 2);
  ctx.stroke();

  ctx.strokeStyle = `rgba(255, 200, 80, ${alpha * 0.8})`;
  ctx.lineWidth = 5 * (1 - t * 0.7);
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, ringRadius * 0.6, 0, Math.PI * 2);
  ctx.stroke();

  const numShards = 10;
  const seed = (player.id.charCodeAt(player.id.length - 1) || 0) * 0.37;
  for (let i = 0; i < numShards; i += 1) {
    const angle = (i / numShards) * Math.PI * 2 + seed;
    const dist = baseRadius * (1 + ease * 5);
    const px = screen.x + Math.cos(angle) * dist;
    const py = screen.y + Math.sin(angle) * dist;
    const partRadius = baseRadius * 0.18 * (1 - t);
    ctx.fillStyle = `rgba(120, 30, 18, ${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, partRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (t < 0.3) {
    const flashAlpha = (0.3 - t) / 0.3 * 0.7;
    ctx.fillStyle = `rgba(255, 230, 180, ${flashAlpha})`;
    ctx.beginPath();
    ctx.arc(screen.x, screen.y, baseRadius * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
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
  drawCoins(state.snapshot.match.map);
  drawMoveAndAimPreview();
  drawBullets();
  drawPlayers();
  ctx.restore();
  drawSpectatorHint();
  drawOverlayText();
  checkKillNotices();
  drawKillNotice();
  checkDeathNotice();
  drawDeathNotice();
  renderHud();
  renderPhaseBanner();
  checkPlanningTimeout();
  state.animationFrame = requestAnimationFrame(render);
}

const DEATH_FLAVOR = [
  "got smoked by",
  "ate lead from",
  "took a slug from",
  "outdrawn by",
  "got plugged by",
  "lost the duel to",
  "caught a bullet from",
  "got dropped by",
  "made history dying to"
];

const KILL_FLAVOR = [
  (name) => `You dropped ${name}`,
  (name) => `${name} ate lead`,
  (name) => `You put ${name} in the dirt`,
  (name) => `${name} hit the floor`
];

function formatVictimList(victims) {
  return victims.length === 2
    ? `${victims[0]} and ${victims[1]}`
    : `${victims.slice(0, -1).join(", ")}, and ${victims[victims.length - 1]}`;
}

function killHeadline(count) {
  if (count === 2) return "DOUBLE KILL";
  if (count === 3) return "TRIPLE KILL";
  if (count === 4) return "QUADRA KILL";
  if (count === 5) return "PENTA KILL";
  return `${count} KILLS`;
}

function queueKillNotice(notice) {
  state.killNoticeQueue.push(notice);
}

function checkKillNotices() {
  if (!state.snapshot) return;
  if (state.snapshot.room.phase !== "shooting") return;
  const shooting = state.snapshot.match?.shooting;
  if (!shooting?.kills?.length) return;
  const elapsed = currentPlaybackServerNow() - shooting.startedAt;
  const myKills = shooting.kills.filter((kill) => kill.shooterId === state.snapshot.you.id);
  const shotGroups = new Map();
  for (const kill of myKills) {
    if (elapsed < kill.timeMs) continue;
    const shotKey =
      kill.bulletId ||
      `${state.snapshot.match.currentRound}-${state.snapshot.match.turnNumber}-${kill.victimId}`;
    const victim = state.snapshot.players.find((player) => player.id === kill.victimId);
    if (!shotGroups.has(shotKey)) {
      shotGroups.set(shotKey, []);
    }
    shotGroups.get(shotKey).push(victim ? victim.name : "Unknown");
  }

  for (const [shotKey, victims] of shotGroups.entries()) {
    if (state.seenKillNoticeKeys.has(shotKey)) continue;
    state.seenKillNoticeKeys.add(shotKey);
    if (victims.length === 1) {
      const text = KILL_FLAVOR[Math.floor(Math.random() * KILL_FLAVOR.length)](victims[0]);
      pushMessage(`${text}.`);
      queueKillNotice({ text, variant: "standard", lifeMs: 2200 });
      continue;
    }

    const victimsText = formatVictimList(victims);
    pushMessage(`That shot got ${victims.length} kills: ${victimsText}.`);
    const headline = killHeadline(victims.length);
    if (victims.length >= 3) {
      queueKillNotice({
        text: headline,
        subtitle: `${victims.length} kills in one shot`,
        variant: "mega",
        lifeMs: 3200
      });
    } else {
      queueKillNotice({
        text: headline,
        subtitle: "2 kills in one shot",
        variant: "standard",
        lifeMs: 2400
      });
    }
  }
}

function drawKillNotice() {
  if (!state.killNotice && state.killNoticeQueue.length) {
    const next = state.killNoticeQueue.shift();
    state.killNotice = {
      text: next.text || String(next),
      subtitle: next.subtitle || "",
      variant: next.variant || "standard",
      lifeMs: next.lifeMs || 2200,
      startMs: performance.now()
    };
  }

  const notice = state.killNotice;
  if (!notice) return;
  const age = performance.now() - notice.startMs;
  const lifeMs = notice.lifeMs || 2200;
  if (age > lifeMs) {
    state.killNotice = null;
    return;
  }
  const t = age / lifeMs;
  const fadeIn = Math.min(1, age / 140);
  const fadeOut = t > 0.72 ? (1 - t) / 0.28 : 1;
  const alpha = fadeIn * fadeOut;
  const cx = window.innerWidth / 2;

  if (notice.variant === "mega") {
    const cy = window.innerHeight * 0.28;
    const pulse = 1 + Math.sin(t * Math.PI * 6) * 0.08 * (1 - t);
    const ringAlpha = alpha * (1 - t * 0.4);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(pulse, pulse);
    ctx.textAlign = "center";

    for (let i = 0; i < 18; i += 1) {
      const angle = (i / 18) * Math.PI * 2;
      const inner = 74 + t * 12;
      const outer = 128 + t * 26;
      ctx.strokeStyle = `rgba(255, 214, 102, ${ringAlpha * 0.6})`;
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * inner, Math.sin(angle) * inner);
      ctx.lineTo(Math.cos(angle) * outer, Math.sin(angle) * outer);
      ctx.stroke();
    }

    ctx.lineWidth = 10;
    ctx.strokeStyle = `rgba(20, 12, 8, ${alpha * 0.82})`;
    ctx.font = "900 64px Trebuchet MS";
    ctx.strokeText(notice.text, 0, 0);
    ctx.fillStyle = `rgba(220, 60, 40, ${alpha})`;
    ctx.fillText(notice.text, 0, 0);

    ctx.font = "900 22px Trebuchet MS";
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(20, 12, 8, ${alpha * 0.68})`;
    ctx.strokeText(notice.subtitle, 0, 36);
    ctx.fillStyle = `rgba(255, 221, 130, ${alpha})`;
    ctx.fillText(notice.subtitle, 0, 36);
    ctx.restore();
    return;
  }

  const yOffset = 18 + (1 - fadeIn) * 18;
  const cy = window.innerHeight * 0.32 + yOffset;
  ctx.save();
  ctx.textAlign = "center";
  ctx.font = "900 30px Trebuchet MS";
  ctx.lineWidth = 6;
  ctx.strokeStyle = `rgba(20, 12, 8, ${alpha * 0.7})`;
  ctx.strokeText(notice.text, cx, cy);
  ctx.fillStyle = `rgba(45, 106, 79, ${alpha})`;
  ctx.fillText(notice.text, cx, cy);
  if (notice.subtitle) {
    ctx.font = "800 16px Trebuchet MS";
    ctx.lineWidth = 4;
    ctx.strokeText(notice.subtitle, cx, cy + 22);
    ctx.fillStyle = `rgba(240, 232, 210, ${alpha})`;
    ctx.fillText(notice.subtitle, cx, cy + 22);
  }
  ctx.restore();
}

function checkDeathNotice() {
  if (!state.snapshot) return;
  if (state.snapshot.room.phase !== "shooting") return;
  const shooting = state.snapshot.match?.shooting;
  if (!shooting) return;
  const myEntry = shooting.byPlayer?.[state.snapshot.you.id];
  if (!myEntry || myEntry.diedAtMs === null || myEntry.diedAtMs === undefined) return;
  const elapsed = currentPlaybackServerNow() - shooting.startedAt;
  if (elapsed < myEntry.diedAtMs) return;
  triggerDeathNoticeFromSnapshot(state.snapshot, "playback");
}

function triggerDeathNoticeFromSnapshot(snapshot, reason) {
  const shooting = snapshot.match?.shooting;
  const myEntry = shooting?.byPlayer?.[snapshot.you.id] || null;
  const key = `${snapshot.match?.currentRound || 0}-${snapshot.match?.turnNumber || 0}-${reason}`;
  if (state.deathNoticeKey === key) return;
  state.deathNoticeKey = key;
  const killer = myEntry?.killerId
    ? snapshot.players.find((p) => p.id === myEntry.killerId)
    : null;
  let title;
  let subtitle = "";
  if (killer && killer.id === state.snapshot.you.id) {
    const own = ["Bounced your own bullet into yourself", "Shot yourself, smooth", "Friendly fire — you're dead", "Your own ricochet got you"];
    title = own[Math.floor(Math.random() * own.length)];
  } else {
    const flavor = DEATH_FLAVOR[Math.floor(Math.random() * DEATH_FLAVOR.length)];
    title = killer ? `You ${flavor} ${killer.name}` : "You died";
    subtitle = killer ? `Killed by ${killer.name}` : "Respawn next planning phase";
  }
  state.deathNotice = { title, subtitle, startMs: performance.now() };
  pushMessage(`${title}.`);
}

function drawDeathNotice() {
  const notice = state.deathNotice;
  if (!notice) return;
  const age = performance.now() - notice.startMs;
  const lifeMs = 4200;
  if (age > lifeMs) { state.deathNotice = null; return; }
  const t = age / lifeMs;
  const fadeIn = Math.min(1, age / 200);
  const fadeOut = t > 0.7 ? (1 - t) / 0.3 : 1;
  const alpha = fadeIn * fadeOut;
  const yOffset = -20 + (1 - fadeIn) * 20;
  const cx = window.innerWidth / 2;
  const cy = window.innerHeight / 2 + yOffset;
  ctx.save();
  ctx.fillStyle = `rgba(120, 18, 12, ${alpha * 0.18})`;
  ctx.fillRect(0, 0, window.innerWidth, window.innerHeight);
  ctx.strokeStyle = `rgba(220, 60, 40, ${alpha * 0.55})`;
  ctx.lineWidth = 14;
  ctx.strokeRect(7, 7, window.innerWidth - 14, window.innerHeight - 14);
  ctx.textAlign = "center";
  ctx.font = "900 16px Trebuchet MS";
  ctx.fillStyle = `rgba(255, 221, 130, ${alpha})`;
  ctx.fillText("YOU WERE KILLED", cx, cy - 42);
  ctx.font = "900 38px Trebuchet MS";
  ctx.lineWidth = 7;
  ctx.strokeStyle = `rgba(20, 12, 8, ${alpha * 0.78})`;
  ctx.strokeText(notice.title, cx, cy);
  ctx.fillStyle = `rgba(220, 60, 40, ${alpha})`;
  ctx.fillText(notice.title, cx, cy);
  if (notice.subtitle) {
    ctx.font = "800 18px Trebuchet MS";
    ctx.lineWidth = 5;
    ctx.strokeStyle = `rgba(20, 12, 8, ${alpha * 0.62})`;
    ctx.strokeText(notice.subtitle, cx, cy + 32);
    ctx.fillStyle = `rgba(250, 246, 234, ${alpha})`;
    ctx.fillText(notice.subtitle, cx, cy + 32);
  }
  ctx.restore();
}

const PHASE_LABELS = {
  planning: "PLAN",
  movement: "MOVE",
  shooting: "SHOOT",
  lobby: "LOBBY",
  lobby_countdown: "STARTING",
  round_countdown: "READY",
  round_end: "ROUND END",
  match_end: "MATCH END"
};

function renderPhaseBanner() {
  const phase = state.snapshot?.room?.phase;
  const active = !!state.snapshot?.match?.active || phase === "lobby_countdown" || phase === "round_countdown" || phase === "planning" || phase === "movement" || phase === "shooting";
  if (!phase || !active) {
    ui.phaseBanner.classList.add("hidden");
    return;
  }
  ui.phaseBanner.classList.remove("hidden");
  ui.phaseBanner.setAttribute("data-phase", phase);
  ui.phaseBannerText.textContent = PHASE_LABELS[phase] || phase.toUpperCase();
  const duration = state.phaseDurationMs;
  const elapsed = state.phaseLocalStartMs ? performance.now() - state.phaseLocalStartMs : 0;
  const fraction = duration && duration > 0 ? clamp(1 - elapsed / duration, 0, 1) : 0;
  ui.phaseBannerFill.style.width = `${(fraction * 100).toFixed(1)}%`;
}

const PHASE_BG_COLORS = {
  planning: "#ece9d6",
  movement: "#e4e8ec",
  shooting: "#ede0d8",
  lobby: "#ede2c8",
  lobby_countdown: "#ece5d0",
  round_countdown: "#ece5d0",
  round_end: "#ede0cb",
  match_end: "#ede0cb"
};

function currentMapBgColor() {
  const phase = state.snapshot?.room?.phase;
  return PHASE_BG_COLORS[phase] || "#ede2c8";
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
  state.planLocked = true;
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
  if (state.planLocked) return false;
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
    console.log("[beginPlanDrag] bail: alive or phase", { alive: state.snapshot?.you?.alive, phase: state.snapshot?.room?.phase });
    return false;
  }
  const mode = state.inputStep;
  const updated = updatePlanDraftFromScreenPoint(point, mode);
  if (!updated) {
    console.log("[beginPlanDrag] bail: updatePlanDraftFromScreenPoint returned false", { point, mode });
    return false;
  }
  state.dragPlan.active = true;
  state.dragPlan.mode = mode;
  state.dragPlan.pointerType = pointerType;
  console.log("[beginPlanDrag] ok", { mode, point });
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
  console.log("[pointerdown]", { type: event.pointerType, button: event.button, phase: state.snapshot?.room?.phase, alive: state.snapshot?.you?.alive, target: event.target?.tagName });
  sounds.unlock();
  if (!state.snapshot?.match?.active) {
    console.log("[pointerdown] bail: match not active");
    return;
  }
  if (event.pointerType === "touch") {
    console.log("[pointerdown] bail: pointerType=touch (handled by touchstart)");
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

bind(ui.createRoomButton, "click", async () => {
  sounds.unlock();
  ui.menuMessage.textContent = "Creating room...";
  try {
    await joinRoom("", { mode: ui.modeInput.value, createNew: true });
  } catch (error) {
    ui.menuMessage.textContent = error.message;
  }
});

bind(ui.joinRoomButton, "click", async () => {
  sounds.unlock();
  ui.menuMessage.textContent = "Joining room...";
  try {
    await joinRoom(ui.roomCodeInput.value);
  } catch (error) {
    ui.menuMessage.textContent = error.message;
  }
});

bind(ui.scoreTile, "click", () => {
  state.leaderboardOpen = !state.leaderboardOpen;
  renderLeaderboard();
});

function renderLeaderboard() {
  const open = !!state.leaderboardOpen && state.snapshot?.match?.active;
  ui.leaderboard.classList.toggle("hidden", !open);
  ui.scoreTile.classList.toggle("open", open);
  if (!open || !state.snapshot) return;
  const isDeathmatch = isDeathmatchMode(state.snapshot.room.mode);
  const isTeam = isTeamMode(state.snapshot.room.mode);
  const isCoins = isCoinMode(state.snapshot.room.mode);
  const players = state.snapshot.players || [];
  const rows = players.map((p) => ({
    id: p.id,
    name: p.name,
    score: isCoins ? (state.snapshot.match.coinScores?.[p.id] ?? 0) : (isDeathmatch ? (state.snapshot.match.kills?.[p.id] ?? 0) : (p.wins || 0)),
    alive: p.alive,
    connected: p.connected,
    team: p.team || null
  }));
  if (isCoins) {
    const teamScore = (team) => (state.snapshot.match.teamCoins?.[team] ?? 0);
    rows.sort((a, b) => teamScore(b.team) - teamScore(a.team) || b.score - a.score || a.name.localeCompare(b.name));
  } else if (isTeam) {
    const teamScore = (team) => (state.snapshot.match.teamKills?.[team] ?? 0);
    rows.sort((a, b) => teamScore(b.team) - teamScore(a.team) || b.score - a.score || a.name.localeCompare(b.name));
  } else {
    rows.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  }
  const myId = state.snapshot.you.id;
  ui.leaderboardList.innerHTML = rows
    .map((r) => {
      const cls = r.id === myId ? "you" : "";
      const dim = !r.connected || (isDeathmatch && !r.alive) ? " style=\"opacity:0.5\"" : "";
      const suffix = isCoins ? " coins" : (isDeathmatch ? "K" : "W");
      const teamBadge = isTeam && r.team
        ? `<span class="team-badge team-${r.team}">${escapeHtml(teamLabel(r.team))}</span>`
        : "";
      return `<li class="${cls}"${dim}><span class="name">${teamBadge}<span class="name-text">${escapeHtml(r.name)}</span></span><span class="score">${r.score}${suffix}</span></li>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

bind(ui.createBrButton, "click", async () => {
  sounds.unlock();
  ui.menuMessage.textContent = "Joining human battle royale...";
  try {
    await joinRoom("", { mode: "br" });
  } catch (error) {
    ui.menuMessage.textContent = error.message;
  }
});

bind(ui.createBrBotsButton, "click", async () => {
  sounds.unlock();
  ui.menuMessage.textContent = "Joining full bot battle royale...";
  try {
    await joinRoom("", { mode: "br", fillBots: true });
  } catch (error) {
    ui.menuMessage.textContent = error.message;
  }
});

bind(ui.startGameButton, "click", async () => {
  sounds.unlock();
  try {
    await startGame();
    pushMessage("Host started the match countdown.");
  } catch (error) {
    pushMessage(error.message);
  }
});

bind(ui.startTestButton, "click", async () => {
  sounds.unlock();
  try {
    await startGame({ testMode: true });
    pushMessage("Test mode (1P) starting...");
  } catch (error) {
    pushMessage(error.message);
  }
});

bind(ui.addBotButton, "click", async () => {
  sounds.unlock();
  try {
    await api("/api/add-bot", { method: "POST", body: { token: state.token } });
    pushMessage("Bot added.");
  } catch (error) {
    pushMessage(error.message);
  }
});

bind(ui.roomCodeInput, "input", () => {
  ui.roomCodeInput.value = ui.roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
});

bind(ui.botCountInput, "input", () => {
  const value = clamp(Math.floor(Number(ui.botCountInput.value) || 0), 0, 49);
  ui.botCountInput.value = String(value);
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
