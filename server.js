const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const CONFIG = {
  port: Number(process.env.PORT) || 3000,
  tickMs: 50,
  pollGraceMs: 10_000,
  lobbyCleanupMs: 30_000,
  minPlayers: 2,
  maxPlayers: 8,
  totalRounds: 3,
  lobbyCountdownMs: 3_000,
  preRoundCountdownMs: 3_000,
  planningMs: 10_000,
  movementMs: 2_000,
  roundEndPauseMs: 3_000,
  screenWidth: 1600,
  screenHeight: 900,
  mapScreensWide: 2,
  mapScreensHigh: 2,
  defaultBuildingCount: 30,
  playerRadius: 18,
  moveRange: 360,
  bulletSpeed: 1600,
  planAimPreviewLength: 90,
  buildingAngles: [0, 45, 90, 135],
  roomCodeLength: 4
};

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const PUBLIC_DIR = path.join(__dirname, "public");
const rooms = new Map();
const sessions = new Map();
let globalPlayerSerial = 1;
let globalMatchSerial = 1;

function nowMs() {
  return Date.now();
}

function randomId(length = 12) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < length; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

function generateRoomCode() {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const code = randomId(CONFIG.roomCodeLength);
    if (!rooms.has(code)) {
      return code;
    }
  }
  throw new Error("Unable to generate a room code.");
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function normalizeVector(vector, fallback = { x: 0, y: -1 }) {
  const length = Math.hypot(vector.x, vector.y);
  if (!length) {
    return { x: fallback.x, y: fallback.y };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

function subtract(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

function scale(vector, scalar) {
  return { x: vector.x * scalar, y: vector.y * scalar };
}

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpPoint(a, b, t) {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

function almostEqual(a, b, epsilon = 1e-6) {
  return Math.abs(a - b) <= epsilon;
}

function rotateIntoLocal(point, building) {
  const dx = point.x - building.x;
  const dy = point.y - building.y;
  const cos = Math.cos(-building.angleRad);
  const sin = Math.sin(-building.angleRad);
  return {
    x: dx * cos - dy * sin,
    y: dx * sin + dy * cos
  };
}

function rotateVectorIntoLocal(vector, building) {
  const cos = Math.cos(-building.angleRad);
  const sin = Math.sin(-building.angleRad);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos
  };
}

function liangBarsky(start, end, minX, maxX, minY, maxY) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  let t0 = 0;
  let t1 = 1;
  const checks = [
    [-dx, start.x - minX],
    [dx, maxX - start.x],
    [-dy, start.y - minY],
    [dy, maxY - start.y]
  ];

  for (const [p, q] of checks) {
    if (almostEqual(p, 0)) {
      if (q < 0) {
        return null;
      }
      continue;
    }
    const ratio = q / p;
    if (p < 0) {
      if (ratio > t1) {
        return null;
      }
      if (ratio > t0) {
        t0 = ratio;
      }
    } else {
      if (ratio < t0) {
        return null;
      }
      if (ratio < t1) {
        t1 = ratio;
      }
    }
  }

  return { enter: t0, exit: t1 };
}

function segmentIntersectsExpandedBuilding(start, end, building, expandBy) {
  const localStart = rotateIntoLocal(start, building);
  const localEnd = rotateIntoLocal(end, building);
  const hit = liangBarsky(
    localStart,
    localEnd,
    -building.halfWidth - expandBy,
    building.halfWidth + expandBy,
    -building.halfHeight - expandBy,
    building.halfHeight + expandBy
  );
  return hit !== null;
}

function pointBlockedByBuilding(point, radius, map) {
  for (const building of map.buildings) {
    const local = rotateIntoLocal(point, building);
    if (
      Math.abs(local.x) <= building.halfWidth + radius &&
      Math.abs(local.y) <= building.halfHeight + radius
    ) {
      return true;
    }
  }
  return false;
}

function insideWorld(point, radius, map) {
  return (
    point.x >= radius &&
    point.x <= map.width - radius &&
    point.y >= radius &&
    point.y <= map.height - radius
  );
}

function segmentClearForCircle(start, end, radius, map) {
  if (!insideWorld(end, radius, map)) {
    return false;
  }
  if (pointBlockedByBuilding(end, radius, map)) {
    return false;
  }
  for (const building of map.buildings) {
    if (segmentIntersectsExpandedBuilding(start, end, building, radius)) {
      return false;
    }
  }
  return true;
}

function furthestReachablePoint(start, target, radius, map) {
  let clamped = {
    x: clamp(target.x, radius, map.width - radius),
    y: clamp(target.y, radius, map.height - radius)
  };
  if (segmentClearForCircle(start, clamped, radius, map)) {
    return clamped;
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 18; i += 1) {
    const mid = (low + high) / 2;
    const probe = lerpPoint(start, clamped, mid);
    if (segmentClearForCircle(start, probe, radius, map)) {
      low = mid;
    } else {
      high = mid;
    }
  }
  return lerpPoint(start, clamped, low);
}

function rayVsAxisAlignedRect(origin, direction, minX, maxX, minY, maxY) {
  let tMin = -Infinity;
  let tMax = Infinity;
  const axes = [
    { origin: origin.x, direction: direction.x, min: minX, max: maxX },
    { origin: origin.y, direction: direction.y, min: minY, max: maxY }
  ];

  for (const axis of axes) {
    if (almostEqual(axis.direction, 0)) {
      if (axis.origin < axis.min || axis.origin > axis.max) {
        return null;
      }
      continue;
    }
    const t1 = (axis.min - axis.origin) / axis.direction;
    const t2 = (axis.max - axis.origin) / axis.direction;
    const enter = Math.min(t1, t2);
    const exit = Math.max(t1, t2);
    tMin = Math.max(tMin, enter);
    tMax = Math.min(tMax, exit);
    if (tMin > tMax) {
      return null;
    }
  }

  if (tMax < 0) {
    return null;
  }

  return tMin >= 0 ? tMin : tMax >= 0 ? 0 : null;
}

function raycastToMap(origin, direction, map) {
  const localHits = [];
  for (const building of map.buildings) {
    const localOrigin = rotateIntoLocal(origin, building);
    const localDirection = normalizeVector(rotateVectorIntoLocal(direction, building), direction);
    const hit = rayVsAxisAlignedRect(
      localOrigin,
      localDirection,
      -building.halfWidth,
      building.halfWidth,
      -building.halfHeight,
      building.halfHeight
    );
    if (hit !== null && hit >= 0) {
      localHits.push(hit);
    }
  }

  const wallDistances = [];
  if (direction.x > 0) {
    wallDistances.push((map.width - origin.x) / direction.x);
  } else if (direction.x < 0) {
    wallDistances.push((0 - origin.x) / direction.x);
  }
  if (direction.y > 0) {
    wallDistances.push((map.height - origin.y) / direction.y);
  } else if (direction.y < 0) {
    wallDistances.push((0 - origin.y) / direction.y);
  }

  const positiveWallDistances = wallDistances.filter((value) => value >= 0);
  const wallDistance = positiveWallDistances.length ? Math.min(...positiveWallDistances) : 0;
  const buildingDistance = localHits.length ? Math.min(...localHits) : Infinity;
  const distanceToHit = Math.min(wallDistance, buildingDistance);
  return {
    distance: distanceToHit,
    hitPoint: add(origin, scale(direction, distanceToHit))
  };
}

function lineOfSightClear(start, end, map) {
  for (const building of map.buildings) {
    if (segmentIntersectsExpandedBuilding(start, end, building, 0)) {
      return false;
    }
  }
  return true;
}

function rayCircleHitDistance(origin, direction, center, radius) {
  const offset = subtract(center, origin);
  const projected = offset.x * direction.x + offset.y * direction.y;
  if (projected < 0) {
    return null;
  }
  const closestSq =
    offset.x * offset.x + offset.y * offset.y - projected * projected;
  const radiusSq = radius * radius;
  if (closestSq > radiusSq) {
    return null;
  }
  const thc = Math.sqrt(radiusSq - closestSq);
  const entry = projected - thc;
  if (entry < 0) {
    return projected + thc;
  }
  return entry;
}

function serializeBuilding(building) {
  return {
    x: building.x,
    y: building.y,
    width: building.width,
    height: building.height,
    angleDeg: building.angleDeg
  };
}

function createRoom(code) {
  return {
    code,
    createdAt: nowMs(),
    players: new Map(),
    phase: "lobby",
    phaseStartedAt: nowMs(),
    phaseEndsAt: null,
    phaseLabel: "Waiting for players",
    match: null,
    round: null,
    lastRoundSummary: null,
    lastMatchSummary: null
  };
}

function connectedPlayers(room) {
  return Array.from(room.players.values()).filter((player) => player.connected);
}

function activeLobbyPlayers(room) {
  return Array.from(room.players.values()).filter((player) => {
    if (room.match && room.match.participantIds.includes(player.id)) {
      return player.connected;
    }
    return player.connected;
  });
}

function setPhase(room, phase, durationMs, label) {
  const current = nowMs();
  room.phase = phase;
  room.phaseStartedAt = current;
  room.phaseEndsAt = durationMs === null ? null : current + durationMs;
  room.phaseLabel = label;
}

function generateGuestName(room) {
  const taken = new Set(Array.from(room.players.values()).map((player) => player.name));
  let counter = 1;
  while (counter < 10_000) {
    const name = `Guest ${counter}`;
    if (!taken.has(name)) {
      return name;
    }
    counter += 1;
  }
  return `Guest ${randomId(4)}`;
}

function generateColor(serial) {
  const palette = [
    "#ff6f61",
    "#f7b32b",
    "#2ec4b6",
    "#3a86ff",
    "#ff006e",
    "#8ac926",
    "#8338ec",
    "#fb5607"
  ];
  return palette[(serial - 1) % palette.length];
}

function sanitizeRoomCode(rawCode) {
  const value = String(rawCode || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .slice(0, CONFIG.roomCodeLength);
  return value;
}

function generateMap() {
  const map = {
    width: CONFIG.screenWidth * CONFIG.mapScreensWide,
    height: CONFIG.screenHeight * CONFIG.mapScreensHigh,
    buildings: []
  };

  const corridorPadding = 110;
  for (let attempt = 0; attempt < 2000 && map.buildings.length < CONFIG.defaultBuildingCount; attempt += 1) {
    const angleDeg =
      CONFIG.buildingAngles[Math.floor(Math.random() * CONFIG.buildingAngles.length)];
    const width = 120 + Math.random() * 260;
    const height = 80 + Math.random() * 220;
    const building = {
      x: 160 + Math.random() * (map.width - 320),
      y: 160 + Math.random() * (map.height - 320),
      width,
      height,
      halfWidth: width / 2,
      halfHeight: height / 2,
      angleDeg,
      angleRad: (angleDeg * Math.PI) / 180
    };

    let blocked = false;
    for (const other of map.buildings) {
      const dx = Math.abs(building.x - other.x);
      const dy = Math.abs(building.y - other.y);
      const limitX = building.halfWidth + other.halfWidth + corridorPadding;
      const limitY = building.halfHeight + other.halfHeight + corridorPadding;
      if (dx < limitX && dy < limitY) {
        blocked = true;
        break;
      }
    }
    if (!blocked) {
      map.buildings.push(building);
    }
  }
  return map;
}

function findSpawnPoints(map, count) {
  const points = [];
  const minDistance = 460;
  for (let attempt = 0; attempt < 5000 && points.length < count; attempt += 1) {
    const candidate = {
      x: 120 + Math.random() * (map.width - 240),
      y: 120 + Math.random() * (map.height - 240)
    };
    if (!insideWorld(candidate, CONFIG.playerRadius, map)) {
      continue;
    }
    if (pointBlockedByBuilding(candidate, CONFIG.playerRadius + 20, map)) {
      continue;
    }
    let valid = true;
    let blockedLosCount = 0;
    for (const existing of points) {
      if (distance(candidate, existing) < minDistance) {
        valid = false;
        break;
      }
      if (!lineOfSightClear(candidate, existing, map)) {
        blockedLosCount += 1;
      }
    }
    if (!valid) {
      continue;
    }
    if (points.length > 0 && blockedLosCount < Math.floor(points.length / 2)) {
      continue;
    }
    points.push(candidate);
  }

  while (points.length < count) {
    points.push({
      x: 180 + (points.length * 150) % (map.width - 360),
      y: 180 + ((points.length * 240) % (map.height - 360))
    });
  }

  return points;
}

function createFreshPlan(player) {
  return {
    moveTarget: null,
    aimDir: { x: player.lastAimDir.x, y: player.lastAimDir.y },
    ready: false,
    updatedAt: nowMs()
  };
}

function resetPlayerForRound(player, spawnPoint) {
  player.roundAlive = true;
  player.spectating = false;
  player.x = spawnPoint.x;
  player.y = spawnPoint.y;
  player.spawnX = spawnPoint.x;
  player.spawnY = spawnPoint.y;
  player.roundDeathAtMs = null;
  player.lastAimDir = { x: 0, y: -1 };
  player.plan = createFreshPlan(player);
}

function beginLobbyCountdown(room) {
  setPhase(room, "lobby_countdown", CONFIG.lobbyCountdownMs, "Match starts soon");
}

function startMatch(room) {
  const participants = connectedPlayers(room).slice(0, CONFIG.maxPlayers);
  if (participants.length < CONFIG.minPlayers) {
    setPhase(room, "lobby", null, "Waiting for players");
    return;
  }

  room.match = {
    id: `match-${globalMatchSerial++}`,
    participantIds: participants.map((player) => player.id),
    roundWins: Object.fromEntries(participants.map((player) => [player.id, 0])),
    totalSurvivalMs: Object.fromEntries(participants.map((player) => [player.id, 0])),
    currentRoundNumber: 0
  };
  room.lastRoundSummary = null;
  room.lastMatchSummary = null;
  startRound(room);
}

function startRound(room) {
  if (!room.match) {
    return;
  }
  room.match.currentRoundNumber += 1;
  const participantIds = room.match.participantIds;
  const map = generateMap();
  const spawns = findSpawnPoints(map, participantIds.length);
  room.round = {
    number: room.match.currentRoundNumber,
    map,
    turnNumber: 0,
    roundStartedAt: null,
    planningVisibility: {},
    currentTurn: null
  };

  participantIds.forEach((playerId, index) => {
    const player = room.players.get(playerId);
    if (!player) {
      return;
    }
    resetPlayerForRound(player, spawns[index]);
  });

  setPhase(room, "round_countdown", CONFIG.preRoundCountdownMs, `Round ${room.round.number} starts`);
}

function visibleEnemiesForPlayer(room, viewerId) {
  const viewer = room.players.get(viewerId);
  if (!viewer || !viewer.roundAlive) {
    return [];
  }
  const visible = [];
  for (const playerId of room.match.participantIds) {
    if (playerId === viewerId) {
      continue;
    }
    const target = room.players.get(playerId);
    if (!target || !target.roundAlive) {
      continue;
    }
    if (lineOfSightClear(viewer, target, room.round.map)) {
      visible.push(playerId);
    }
  }
  return visible;
}

function startPlanning(room) {
  if (!room.round || !room.match) {
    return;
  }
  room.round.turnNumber += 1;
  room.round.currentTurn = {
    turnNumber: room.round.turnNumber,
    startedAt: nowMs(),
    plans: {}
  };
  if (!room.round.roundStartedAt) {
    room.round.roundStartedAt = room.round.currentTurn.startedAt;
  }
  room.round.planningVisibility = {};

  for (const playerId of room.match.participantIds) {
    const player = room.players.get(playerId);
    if (!player) {
      continue;
    }
    player.plan = createFreshPlan(player);
    room.round.currentTurn.plans[player.id] = player.plan;
    room.round.planningVisibility[player.id] = visibleEnemiesForPlayer(room, player.id);
  }

  setPhase(room, "planning", CONFIG.planningMs, `Turn ${room.round.turnNumber}`);
}

function normalizedMoveTarget(player, moveTarget) {
  const raw = {
    x: Number(moveTarget.x),
    y: Number(moveTarget.y)
  };
  const delta = subtract(raw, player);
  const length = Math.hypot(delta.x, delta.y);
  if (!length) {
    return { x: player.x, y: player.y };
  }
  const capped = length > CONFIG.moveRange
    ? add(player, scale(normalizeVector(delta), CONFIG.moveRange))
    : raw;
  return capped;
}

function simulateMovement(room, actionMap) {
  const map = room.round.map;
  const radius = CONFIG.playerRadius;
  const steps = 120;
  const players = room.match.participantIds
    .map((playerId) => room.players.get(playerId))
    .filter(Boolean);

  const results = Object.fromEntries(
    players.map((player) => [
      player.id,
      {
        start: { x: player.x, y: player.y },
        end: { x: player.x, y: player.y },
        haltedAtMs: 0,
        hadAction: false
      }
    ])
  );

  const sim = Object.fromEntries(
    players.map((player) => {
      const action = actionMap[player.id];
      const target = action ? action.moveEnd : { x: player.x, y: player.y };
      return [
        player.id,
        {
          current: { x: player.x, y: player.y },
          target,
          moving:
            player.roundAlive &&
            !player.disconnected &&
            action &&
            (distance(player, target) > 1),
          halted: false
        }
      ];
    })
  );

  for (const playerId of Object.keys(actionMap)) {
    results[playerId].hadAction = true;
  }

  for (let stepIndex = 0; stepIndex < steps; stepIndex += 1) {
    const stepT0 = stepIndex / steps;
    const stepT1 = (stepIndex + 1) / steps;
    const proposed = {};

    for (const player of players) {
      const state = sim[player.id];
      if (!state.moving || state.halted) {
        proposed[player.id] = { ...state.current };
        continue;
      }
      proposed[player.id] = lerpPoint(results[player.id].start, state.target, stepT1);
    }

    const collisions = new Set();
    for (let i = 0; i < players.length; i += 1) {
      const a = players[i];
      const aState = sim[a.id];
      if (!aState || !a.roundAlive) {
        continue;
      }
      for (let j = i + 1; j < players.length; j += 1) {
        const b = players[j];
        const bState = sim[b.id];
        if (!bState || !b.roundAlive) {
          continue;
        }
        const proposedDistance = distance(proposed[a.id], proposed[b.id]);
        if (proposedDistance < radius * 2) {
          collisions.add(a.id);
          collisions.add(b.id);
        }
      }
    }

    for (const player of players) {
      const state = sim[player.id];
      if (!state || !player.roundAlive) {
        continue;
      }
      if (collisions.has(player.id)) {
        state.halted = true;
        results[player.id].haltedAtMs = Math.round(stepT0 * CONFIG.movementMs);
        continue;
      }

      state.current = proposed[player.id];
      results[player.id].end = { ...state.current };
      results[player.id].haltedAtMs = Math.round(stepT1 * CONFIG.movementMs);
    }
  }

  for (const player of players) {
    player.x = results[player.id].end.x;
    player.y = results[player.id].end.y;
  }

  return results;
}

function buildActionMap(room) {
  const actionMap = {};
  for (const playerId of room.match.participantIds) {
    const player = room.players.get(playerId);
    if (!player || !player.roundAlive || player.disconnected) {
      continue;
    }
    const plan = player.plan;
    if (!plan || !plan.moveTarget) {
      continue;
    }
    const normalizedTarget = normalizedMoveTarget(player, plan.moveTarget);
    const reachable = furthestReachablePoint(
      { x: player.x, y: player.y },
      normalizedTarget,
      CONFIG.playerRadius,
      room.round.map
    );
    const aimDir = normalizeVector(plan.aimDir, player.lastAimDir);
    actionMap[player.id] = {
      moveEnd: reachable,
      aimDir
    };
    player.lastAimDir = aimDir;
  }
  return actionMap;
}

function beginMovement(room) {
  const actionMap = buildActionMap(room);
  const movement = simulateMovement(room, actionMap);
  room.round.currentTurn.movement = {
    startedAt: nowMs(),
    durationMs: CONFIG.movementMs,
    byPlayer: movement,
    actionMap
  };
  setPhase(room, "movement", CONFIG.movementMs, "Movement");
}

function buildBulletEvents(room) {
  const bullets = [];
  const survivors = room.match.participantIds
    .map((playerId) => room.players.get(playerId))
    .filter((player) => player && player.roundAlive);

  let bulletSerial = 1;
  for (const player of survivors) {
    const plan = player.plan;
    if (!plan || !plan.moveTarget || player.disconnected) {
      continue;
    }
    const direction = normalizeVector(plan.aimDir, player.lastAimDir);
    const wallHit = raycastToMap(player, direction, room.round.map);
    const candidates = survivors
      .filter((target) => target.id !== player.id)
      .map((target) => {
        const distanceToHit = rayCircleHitDistance(player, direction, target, CONFIG.playerRadius);
        if (distanceToHit === null || distanceToHit > wallHit.distance) {
          return null;
        }
        return {
          victimId: target.id,
          timeMs: Math.round((distanceToHit / CONFIG.bulletSpeed) * 1000),
          distance: distanceToHit
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.timeMs - b.timeMs || a.distance - b.distance);

    bullets.push({
      id: `bullet-${room.round.number}-${room.round.turnNumber}-${bulletSerial++}`,
      shooterId: player.id,
      origin: { x: player.x, y: player.y },
      direction,
      wallDistance: wallHit.distance,
      wallPoint: wallHit.hitPoint,
      wallTimeMs: Math.round((wallHit.distance / CONFIG.bulletSpeed) * 1000),
      candidateHits: candidates,
      stopTimeMs: Math.round((wallHit.distance / CONFIG.bulletSpeed) * 1000),
      victimId: null
    });
  }

  const alive = new Set(survivors.map((player) => player.id));
  const activeBullets = new Set(bullets.map((bullet) => bullet.id));
  const eventsByTime = new Map();
  for (const bullet of bullets) {
    for (const candidate of bullet.candidateHits) {
      const key = candidate.timeMs;
      if (!eventsByTime.has(key)) {
        eventsByTime.set(key, []);
      }
      eventsByTime.get(key).push({
        bulletId: bullet.id,
        shooterId: bullet.shooterId,
        victimId: candidate.victimId,
        timeMs: candidate.timeMs
      });
    }
  }

  const orderedTimes = Array.from(eventsByTime.keys()).sort((a, b) => a - b);
  const kills = [];
  for (const timeMs of orderedTimes) {
    const candidates = eventsByTime.get(timeMs);
    const validHits = [];
    const usedBullets = new Set();
    const aliveAtGroupStart = new Set(alive);

    for (const event of candidates) {
      const bullet = bullets.find((entry) => entry.id === event.bulletId);
      if (!bullet || !activeBullets.has(event.bulletId) || usedBullets.has(event.bulletId)) {
        continue;
      }
      if (!aliveAtGroupStart.has(event.victimId)) {
        continue;
      }
      if (timeMs > bullet.wallTimeMs) {
        continue;
      }
      validHits.push(event);
      usedBullets.add(event.bulletId);
    }

    for (const hit of validHits) {
      const bullet = bullets.find((entry) => entry.id === hit.bulletId);
      if (!bullet) {
        continue;
      }
      bullet.victimId = hit.victimId;
      bullet.stopTimeMs = hit.timeMs;
    }

    for (const hit of validHits) {
      if (!alive.has(hit.victimId)) {
        continue;
      }
      alive.delete(hit.victimId);
      activeBullets.delete(hit.bulletId);
      kills.push(hit);
    }
  }

  for (const bullet of bullets) {
    if (bullet.victimId === null) {
      bullet.stopTimeMs = bullet.wallTimeMs;
    }
  }

  const maxDuration = bullets.length
    ? Math.max(...bullets.map((bullet) => bullet.stopTimeMs))
    : 350;

  return {
    startedAt: nowMs(),
    durationMs: Math.max(maxDuration, 350),
    bullets: bullets.map((bullet) => ({
      id: bullet.id,
      shooterId: bullet.shooterId,
      origin: bullet.origin,
      direction: bullet.direction,
      wallPoint: bullet.wallPoint,
      wallTimeMs: bullet.wallTimeMs,
      stopTimeMs: bullet.stopTimeMs,
      victimId: bullet.victimId
    })),
    kills
  };
}

function beginShooting(room) {
  const shooting = buildBulletEvents(room);
  room.round.currentTurn.shooting = shooting;

  const elapsedBeforeShots = shooting.startedAt - room.round.roundStartedAt;
  for (const kill of shooting.kills) {
    const victim = room.players.get(kill.victimId);
    if (!victim || !victim.roundAlive) {
      continue;
    }
    victim.roundAlive = false;
    victim.spectating = true;
    victim.roundDeathAtMs = elapsedBeforeShots + kill.timeMs;
  }

  setPhase(room, "shooting", shooting.durationMs, "Shots");
}

function finalizeRound(room) {
  const now = nowMs();
  const elapsed = room.round.roundStartedAt ? now - room.round.roundStartedAt : 0;
  const participants = room.match.participantIds
    .map((playerId) => room.players.get(playerId))
    .filter(Boolean);
  const survivors = participants.filter((player) => player.roundAlive);

  for (const player of participants) {
    const survivalMs =
      player.roundDeathAtMs !== null ? player.roundDeathAtMs : elapsed;
    room.match.totalSurvivalMs[player.id] += survivalMs;
  }

  let winnerId = null;
  let draw = false;
  if (survivors.length === 1) {
    winnerId = survivors[0].id;
    room.match.roundWins[winnerId] += 1;
  } else {
    draw = true;
  }

  room.lastRoundSummary = {
    roundNumber: room.round.number,
    winnerId,
    draw,
    survivors: survivors.map((player) => player.id)
  };

  setPhase(room, "round_end", CONFIG.roundEndPauseMs, draw ? "Round draw" : "Round complete");
}

function finishMatch(room) {
  const participants = room.match.participantIds
    .map((playerId) => room.players.get(playerId))
    .filter(Boolean);
  const ranked = [...participants].sort((a, b) => {
    const winDelta = room.match.roundWins[b.id] - room.match.roundWins[a.id];
    if (winDelta !== 0) {
      return winDelta;
    }
    return room.match.totalSurvivalMs[b.id] - room.match.totalSurvivalMs[a.id];
  });
  let winnerId = ranked[0] ? ranked[0].id : null;
  if (ranked.length >= 2) {
    const top = ranked[0];
    const second = ranked[1];
    if (
      room.match.roundWins[top.id] === room.match.roundWins[second.id] &&
      room.match.totalSurvivalMs[top.id] === room.match.totalSurvivalMs[second.id]
    ) {
      winnerId = null;
    }
  }

  room.lastMatchSummary = {
    winnerId,
    scoreboard: participants
      .map((player) => ({
        id: player.id,
        name: player.name,
        wins: room.match.roundWins[player.id],
        survivalMs: room.match.totalSurvivalMs[player.id]
      }))
      .sort((a, b) => b.wins - a.wins || b.survivalMs - a.survivalMs)
  };

  room.round = null;
  setPhase(room, "match_end", 5_000, "Match over");
}

function returnRoomToLobby(room) {
  room.match = null;
  room.round = null;
  for (const player of room.players.values()) {
    player.roundAlive = false;
    player.spectating = false;
    player.plan = createFreshPlan(player);
  }
  setPhase(room, "lobby", null, "Waiting for players");
}

function updateRoom(room) {
  const now = nowMs();

  for (const player of room.players.values()) {
    if (player.connected && now - player.lastSeenAt > CONFIG.pollGraceMs) {
      player.connected = false;
      player.disconnected = true;
    }
  }

  if (!room.match) {
    for (const [playerId, player] of room.players.entries()) {
      if (!player.connected && now - player.lastSeenAt > CONFIG.lobbyCleanupMs) {
        sessions.delete(player.token);
        room.players.delete(playerId);
      }
    }
  }

  const connectedCount = connectedPlayers(room).length;

  if (room.phase === "lobby") {
    if (connectedCount >= CONFIG.minPlayers) {
      beginLobbyCountdown(room);
    }
    return;
  }

  if (room.phase === "lobby_countdown") {
    if (connectedCount < CONFIG.minPlayers) {
      setPhase(room, "lobby", null, "Waiting for players");
      return;
    }
    if (room.phaseEndsAt && now >= room.phaseEndsAt) {
      startMatch(room);
    }
    return;
  }

  if (room.phase === "round_countdown" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    startPlanning(room);
    return;
  }

  if (room.phase === "planning" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    beginMovement(room);
    return;
  }

  if (room.phase === "movement" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    beginShooting(room);
    return;
  }

  if (room.phase === "shooting" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    const aliveCount = room.match.participantIds
      .map((playerId) => room.players.get(playerId))
      .filter((player) => player && player.roundAlive).length;
    if (aliveCount <= 1) {
      finalizeRound(room);
    } else {
      startPlanning(room);
    }
    return;
  }

  if (room.phase === "round_end" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    if (room.match.currentRoundNumber >= CONFIG.totalRounds) {
      finishMatch(room);
    } else {
      startRound(room);
    }
    return;
  }

  if (room.phase === "match_end" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    returnRoomToLobby(room);
  }
}

function planningVisibilityForPlayer(room, playerId) {
  if (!room.round) {
    return [];
  }
  return room.round.planningVisibility[playerId] || [];
}

function shouldRevealPlayerToViewer(room, viewer, target) {
  if (!room.match || !room.round || !target) {
    return true;
  }
  if (viewer.id === target.id) {
    return true;
  }
  if (!viewer.roundAlive || viewer.spectating) {
    return true;
  }
  if (room.phase === "planning") {
    return planningVisibilityForPlayer(room, viewer.id).includes(target.id);
  }
  return true;
}

function serializePlayerForViewer(room, viewer, target) {
  const inCurrentMatch = room.match ? room.match.participantIds.includes(target.id) : false;
  const visibleToYou = shouldRevealPlayerToViewer(room, viewer, target);
  return {
    id: target.id,
    name: target.name,
    color: target.color,
    connected: target.connected,
    disconnected: target.disconnected,
    alive: inCurrentMatch ? !!target.roundAlive : false,
    spectating: inCurrentMatch ? !!target.spectating : false,
    x: visibleToYou ? target.x : null,
    y: visibleToYou ? target.y : null,
    wins: room.match ? room.match.roundWins[target.id] || 0 : 0,
    survivalMs: room.match ? room.match.totalSurvivalMs[target.id] || 0 : 0,
    lastAimDir: visibleToYou ? target.lastAimDir : null,
    visibleToYou
  };
}

function buildState(player) {
  const room = rooms.get(player.roomCode);
  const players = Array.from(room.players.values());
  const phaseEndsInMs = room.phaseEndsAt ? Math.max(0, room.phaseEndsAt - nowMs()) : null;

  return {
    ok: true,
    serverNow: nowMs(),
    config: {
      moveRange: CONFIG.moveRange,
      playerRadius: CONFIG.playerRadius,
      planningMs: CONFIG.planningMs,
      movementMs: CONFIG.movementMs,
      bulletSpeed: CONFIG.bulletSpeed,
      screenWidth: CONFIG.screenWidth,
      screenHeight: CONFIG.screenHeight
    },
    room: {
      code: room.code,
      phase: room.phase,
      phaseLabel: room.phaseLabel,
      phaseEndsAt: room.phaseEndsAt,
      phaseEndsInMs,
      connectedCount: connectedPlayers(room).length,
      playerCount: players.length,
      minPlayers: CONFIG.minPlayers,
      maxPlayers: CONFIG.maxPlayers
    },
    you: {
      id: player.id,
      name: player.name,
      color: player.color,
      connected: player.connected,
      disconnected: player.disconnected,
      alive: !!player.roundAlive,
      spectating: !!player.spectating,
      x: player.x,
      y: player.y,
      wins: room.match ? room.match.roundWins[player.id] || 0 : 0,
      survivalMs: room.match ? room.match.totalSurvivalMs[player.id] || 0 : 0,
      lastAimDir: player.lastAimDir
    },
    players: players.map((target) => serializePlayerForViewer(room, player, target)),
    planning: room.round
      ? {
          turnNumber: room.round.turnNumber,
          visibleEnemyIds: planningVisibilityForPlayer(room, player.id),
          plan: player.plan,
          ready: !!player.plan?.moveTarget
        }
      : null,
    match: room.match
      ? {
          active: true,
          currentRound: room.match.currentRoundNumber,
          totalRounds: CONFIG.totalRounds,
          turnNumber: room.round ? room.round.turnNumber : 0,
          participantIds: room.match.participantIds,
          map: room.round
            ? {
                width: room.round.map.width,
                height: room.round.map.height,
                buildings: room.round.map.buildings.map(serializeBuilding)
              }
            : null,
          movement: room.round?.currentTurn?.movement || null,
          shooting: room.round?.currentTurn?.shooting || null,
          roundWins: room.match.roundWins,
          totalSurvivalMs: room.match.totalSurvivalMs
        }
      : {
          active: false
        },
    summaries: {
      round: room.lastRoundSummary,
      match: room.lastMatchSummary
    }
  };
}

async function readJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(chunk);
  }
  if (!chunks.length) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function getPlayerByToken(token) {
  const session = sessions.get(token);
  if (!session) {
    return null;
  }
  const room = rooms.get(session.roomCode);
  if (!room) {
    sessions.delete(token);
    return null;
  }
  const player = room.players.get(session.playerId);
  if (!player) {
    sessions.delete(token);
    return null;
  }
  return player;
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function serveFile(requestPath, response) {
  let filePath = path.join(PUBLIC_DIR, requestPath === "/" ? "index.html" : requestPath);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, buffer) => {
    if (error) {
      response.writeHead(error.code === "ENOENT" ? 404 : 500);
      response.end(error.code === "ENOENT" ? "Not found" : "Server error");
      return;
    }
    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(buffer);
  });
}

async function handleJoin(request, response) {
  const body = await readJsonBody(request);
  const desiredCode = sanitizeRoomCode(body.roomCode);
  if (body.roomCode && desiredCode.length !== CONFIG.roomCodeLength) {
    json(response, 400, { ok: false, error: "Room codes must be 4 characters." });
    return;
  }
  let room = desiredCode ? rooms.get(desiredCode) : null;

  if (room && room.match && !["lobby", "lobby_countdown", "match_end"].includes(room.phase)) {
    json(response, 409, { ok: false, error: "Match already in progress." });
    return;
  }

  if (!room) {
    const code = desiredCode || generateRoomCode();
    room = createRoom(code);
    rooms.set(code, room);
  }

  if (room.players.size >= CONFIG.maxPlayers) {
    json(response, 409, { ok: false, error: "Room is full." });
    return;
  }

  const serial = globalPlayerSerial++;
  const player = {
    id: `player-${serial}`,
    token: randomId(24),
    roomCode: room.code,
    name: generateGuestName(room),
    color: generateColor(serial),
    connected: true,
    disconnected: false,
    lastSeenAt: nowMs(),
    x: CONFIG.screenWidth / 2,
    y: CONFIG.screenHeight / 2,
    spawnX: 0,
    spawnY: 0,
    roundAlive: false,
    spectating: false,
    roundDeathAtMs: null,
    lastAimDir: { x: 0, y: -1 },
    plan: {
      moveTarget: null,
      aimDir: { x: 0, y: -1 },
      ready: false,
      updatedAt: nowMs()
    }
  };

  room.players.set(player.id, player);
  sessions.set(player.token, {
    roomCode: room.code,
    playerId: player.id
  });

  json(response, 200, {
    ok: true,
    token: player.token,
    roomCode: room.code,
    playerId: player.id,
    name: player.name
  });
}

async function handlePlan(request, response) {
  const body = await readJsonBody(request);
  const player = getPlayerByToken(body.token);
  if (!player) {
    json(response, 401, { ok: false, error: "Invalid session." });
    return;
  }
  const room = rooms.get(player.roomCode);
  player.lastSeenAt = nowMs();
  player.connected = true;
  player.disconnected = false;

  if (!room.match || room.phase !== "planning" || !room.round) {
    json(response, 409, { ok: false, error: "Not currently planning." });
    return;
  }
  if (!player.roundAlive || player.disconnected) {
    json(response, 200, { ok: true, ignored: true });
    return;
  }

  const nextPlan = {
    moveTarget: null,
    aimDir: player.plan?.aimDir || player.lastAimDir,
    ready: false,
    updatedAt: nowMs()
  };

  if (body.moveTarget && Number.isFinite(body.moveTarget.x) && Number.isFinite(body.moveTarget.y)) {
    nextPlan.moveTarget = {
      x: Number(body.moveTarget.x),
      y: Number(body.moveTarget.y)
    };
    nextPlan.ready = true;
  }

  if (body.aimDir && Number.isFinite(body.aimDir.x) && Number.isFinite(body.aimDir.y)) {
    nextPlan.aimDir = normalizeVector(
      { x: Number(body.aimDir.x), y: Number(body.aimDir.y) },
      player.lastAimDir
    );
  }

  player.plan = nextPlan;
  if (room.round.currentTurn) {
    room.round.currentTurn.plans[player.id] = nextPlan;
  }

  json(response, 200, { ok: true, plan: nextPlan });
}

async function handleLeave(request, response) {
  const body = await readJsonBody(request);
  const player = getPlayerByToken(body.token);
  if (!player) {
    json(response, 200, { ok: true });
    return;
  }
  player.connected = false;
  player.disconnected = true;
  player.lastSeenAt = nowMs() - CONFIG.pollGraceMs - 1;
  json(response, 200, { ok: true });
}

function handleState(request, response, urlObject) {
  const token = urlObject.searchParams.get("token");
  const player = getPlayerByToken(token);
  if (!player) {
    json(response, 401, { ok: false, error: "Invalid session." });
    return;
  }
  player.lastSeenAt = nowMs();
  player.connected = true;
  player.disconnected = false;
  const state = buildState(player);
  json(response, 200, state);
}

const server = http.createServer(async (request, response) => {
  try {
    const urlObject = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && urlObject.pathname === "/api/state") {
      handleState(request, response, urlObject);
      return;
    }

    if (request.method === "POST" && urlObject.pathname === "/api/join") {
      await handleJoin(request, response);
      return;
    }

    if (request.method === "POST" && urlObject.pathname === "/api/plan") {
      await handlePlan(request, response);
      return;
    }

    if (request.method === "POST" && urlObject.pathname === "/api/leave") {
      await handleLeave(request, response);
      return;
    }

    if (request.method === "GET") {
      serveFile(urlObject.pathname, response);
      return;
    }

    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    console.error(error);
    json(response, 500, { ok: false, error: "Server error." });
  }
});

setInterval(() => {
  for (const room of rooms.values()) {
    updateRoom(room);
    if (room.players.size === 0) {
      rooms.delete(room.code);
    }
  }
}, CONFIG.tickMs);

server.listen(CONFIG.port, () => {
  console.log(`Move and Shoot server listening on http://localhost:${CONFIG.port}`);
});
