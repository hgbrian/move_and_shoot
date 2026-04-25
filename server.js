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
  lobbyCountdownMs: 1_000,
  preRoundCountdownMs: 1_000,
  planningMs: 5_000,
  planningMaxWaitMs: 3_000,
  brMaxPlayers: 100,
  brMapGridSize: 10,
  brKillTarget: 10,
  movementMs: 2_000,
  roundEndPauseMs: 3_000,
  screenSize: 1200,
  defaultMapGridSize: 2,
  defaultBuildingCount: 30,
  playerRadius: 18,
  moveRange: 720,
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
let globalMapSerial = 1;

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

function rotatedRectangleCorners(building, expandBy = 0) {
  const halfWidth = building.halfWidth + expandBy;
  const halfHeight = building.halfHeight + expandBy;
  const cos = Math.cos(building.angleRad);
  const sin = Math.sin(building.angleRad);
  const localCorners = [
    { x: -halfWidth, y: -halfHeight },
    { x: halfWidth, y: -halfHeight },
    { x: halfWidth, y: halfHeight },
    { x: -halfWidth, y: halfHeight }
  ];

  return localCorners.map((corner) => ({
    x: building.x + corner.x * cos - corner.y * sin,
    y: building.y + corner.x * sin + corner.y * cos
  }));
}

function normalizedAxis(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  return { x: -dy / length, y: dx / length };
}

function projectPointsOntoAxis(points, axis) {
  let min = Infinity;
  let max = -Infinity;
  for (const point of points) {
    const projection = point.x * axis.x + point.y * axis.y;
    if (projection < min) {
      min = projection;
    }
    if (projection > max) {
      max = projection;
    }
  }
  return { min, max };
}

function rotatedRectanglesOverlap(a, b, expandBy = 0) {
  const aCorners = rotatedRectangleCorners(a, expandBy);
  const bCorners = rotatedRectangleCorners(b, expandBy);
  const axes = [
    normalizedAxis(aCorners[0], aCorners[1]),
    normalizedAxis(aCorners[1], aCorners[2]),
    normalizedAxis(bCorners[0], bCorners[1]),
    normalizedAxis(bCorners[1], bCorners[2])
  ];

  for (const axis of axes) {
    const aProjection = projectPointsOntoAxis(aCorners, axis);
    const bProjection = projectPointsOntoAxis(bCorners, axis);
    if (aProjection.max < bProjection.min || bProjection.max < aProjection.min) {
      return false;
    }
  }

  return true;
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
  const radiusSq = radius * radius;
  for (const building of map.buildings) {
    const local = rotateIntoLocal(point, building);
    const dx = local.x - clamp(local.x, -building.halfWidth, building.halfWidth);
    const dy = local.y - clamp(local.y, -building.halfHeight, building.halfHeight);
    if (dx * dx + dy * dy < radiusSq) {
      return true;
    }
  }
  return false;
}

function worldCollisionNormal(point, radius, map) {
  if (point.x < radius) {
    return { x: 1, y: 0 };
  }
  if (point.x > map.width - radius) {
    return { x: -1, y: 0 };
  }
  if (point.y < radius) {
    return { x: 0, y: 1 };
  }
  if (point.y > map.height - radius) {
    return { x: 0, y: -1 };
  }
  return null;
}

function rotateLocalVectorToWorld(vector, building) {
  const cos = Math.cos(building.angleRad);
  const sin = Math.sin(building.angleRad);
  return {
    x: vector.x * cos - vector.y * sin,
    y: vector.x * sin + vector.y * cos
  };
}

function buildingCollisionNormal(point, radius, building) {
  const local = rotateIntoLocal(point, building);
  const clampedX = clamp(local.x, -building.halfWidth, building.halfWidth);
  const clampedY = clamp(local.y, -building.halfHeight, building.halfHeight);
  const dx = local.x - clampedX;
  const dy = local.y - clampedY;
  const distSq = dx * dx + dy * dy;
  if (distSq >= radius * radius) {
    return null;
  }

  let normalLocal;
  if (distSq > 1e-8) {
    const dist = Math.sqrt(distSq);
    normalLocal = { x: dx / dist, y: dy / dist };
  } else {
    const penetrationX = building.halfWidth - Math.abs(local.x);
    const penetrationY = building.halfHeight - Math.abs(local.y);
    if (penetrationX < penetrationY) {
      normalLocal = { x: local.x >= 0 ? 1 : -1, y: 0 };
    } else {
      normalLocal = { x: 0, y: local.y >= 0 ? 1 : -1 };
    }
  }
  return normalizeVector(rotateLocalVectorToWorld(normalLocal, building), normalLocal);
}

function collisionNormalsAtPoint(point, radius, map) {
  const normals = [];
  const worldNormal = worldCollisionNormal(point, radius, map);
  if (worldNormal) {
    normals.push(worldNormal);
  }
  for (const building of map.buildings) {
    const normal = buildingCollisionNormal(point, radius, building);
    if (normal) {
      normals.push(normal);
    }
  }
  return normals;
}

function pointClearForCircle(point, radius, map) {
  return insideWorld(point, radius, map) && !pointBlockedByBuilding(point, radius, map);
}

function perpendicular(vector) {
  return { x: -vector.y, y: vector.x };
}

function furthestClearPointAlongDelta(current, delta, radius, map) {
  const fullCandidate = add(current, delta);
  if (
    pointClearForCircle(fullCandidate, radius, map) &&
    segmentClearForCircle(current, fullCandidate, radius, map)
  ) {
    return fullCandidate;
  }

  let low = 0;
  let high = 1;
  for (let i = 0; i < 12; i += 1) {
    const mid = (low + high) / 2;
    const probe = add(current, scale(delta, mid));
    if (
      pointClearForCircle(probe, radius, map) &&
      segmentClearForCircle(current, probe, radius, map)
    ) {
      low = mid;
    } else {
      high = mid;
    }
  }
  const safeT = Math.max(0, low - 0.001);
  return add(current, scale(delta, safeT));
}

function moveCircleWithSliding(current, delta, radius, map) {
  if (!delta.x && !delta.y) {
    return { x: current.x, y: current.y };
  }

  let position = { x: current.x, y: current.y };
  let remaining = { x: delta.x, y: delta.y };

  for (let iter = 0; iter < 6; iter += 1) {
    const remDist = Math.hypot(remaining.x, remaining.y);
    if (remDist < 1e-4) {
      break;
    }

    const advanced = furthestClearPointAlongDelta(position, remaining, radius, map);
    const advancedDelta = subtract(advanced, position);
    const advancedDist = Math.hypot(advancedDelta.x, advancedDelta.y);
    position = advanced;

    if (advancedDist >= remDist - 1e-4) {
      break;
    }

    const remainder = subtract(remaining, advancedDelta);
    const remainderDist = Math.hypot(remainder.x, remainder.y);
    const probeStep = Math.min(remainderDist, Math.max(radius * 0.25, 0.5));
    const probe = {
      x: position.x + (remainder.x / remainderDist) * probeStep,
      y: position.y + (remainder.y / remainderDist) * probeStep
    };
    const normals = collisionNormalsAtPoint(probe, radius, map);
    if (!normals.length) {
      break;
    }

    let collisionNormal = normals[0];
    let strongestIntoWall = dot(remainder, collisionNormal);
    for (const normal of normals.slice(1)) {
      const candidateDot = dot(remainder, normal);
      if (candidateDot < strongestIntoWall) {
        strongestIntoWall = candidateDot;
        collisionNormal = normal;
      }
    }

    if (strongestIntoWall >= 0) {
      break;
    }

    remaining = subtract(remainder, scale(collisionNormal, strongestIntoWall));
  }

  return position;
}

const NAV_CELL_SIZE = 14;

function buildNavGrid(map, radius) {
  const cellSize = NAV_CELL_SIZE;
  const cols = Math.ceil(map.width / cellSize);
  const rows = Math.ceil(map.height / cellSize);
  const walkable = new Uint8Array(cols * rows);
  const buildings = map.buildings.map((b) => ({
    x: b.x,
    y: b.y,
    halfWidth: b.halfWidth,
    halfHeight: b.halfHeight,
    angleRad: b.angleRad,
    boundingRadius: Math.hypot(b.halfWidth, b.halfHeight) + radius
  }));
  for (let cy = 0; cy < rows; cy += 1) {
    const y = cy * cellSize + cellSize / 2;
    for (let cx = 0; cx < cols; cx += 1) {
      const x = cx * cellSize + cellSize / 2;
      const idx = cy * cols + cx;
      if (x < radius || x > map.width - radius || y < radius || y > map.height - radius) continue;
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
  return { cellSize, cols, rows, walkable };
}

function getNavGrid(map) {
  if (!map._nav) {
    map._nav = buildNavGrid(map, CONFIG.playerRadius);
  }
  return map._nav;
}

function nearestWalkableCell(nav, point) {
  const cx0 = clamp(Math.floor(point.x / nav.cellSize), 0, nav.cols - 1);
  const cy0 = clamp(Math.floor(point.y / nav.cellSize), 0, nav.rows - 1);
  if (nav.walkable[cy0 * nav.cols + cx0]) {
    return { cx: cx0, cy: cy0 };
  }
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

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    this.items.push(item);
    this._up(this.items.length - 1);
  }
  pop() {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length) {
      this.items[0] = last;
      this._down(0);
    }
    return top;
  }
  _up(i) {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.items[parent][0] <= this.items[i][0]) break;
      const tmp = this.items[parent];
      this.items[parent] = this.items[i];
      this.items[i] = tmp;
      i = parent;
    }
  }
  _down(i) {
    const n = this.items.length;
    while (true) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let best = i;
      if (l < n && this.items[l][0] < this.items[best][0]) best = l;
      if (r < n && this.items[r][0] < this.items[best][0]) best = r;
      if (best === i) break;
      const tmp = this.items[best];
      this.items[best] = this.items[i];
      this.items[i] = tmp;
      i = best;
    }
  }
}

function findPath(map, startWorld, endWorld, radius) {
  const nav = getNavGrid(map);
  const startCell = nearestWalkableCell(nav, startWorld);
  const endCell = nearestWalkableCell(nav, endWorld);
  if (!startCell || !endCell) return null;
  const cols = nav.cols;
  const rows = nav.rows;
  const startIdx = startCell.cy * cols + startCell.cx;
  const endIdx = endCell.cy * cols + endCell.cx;
  if (startIdx === endIdx) {
    return [{ x: startWorld.x, y: startWorld.y }, { x: endWorld.x, y: endWorld.y }];
  }

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

  const heap = new MinHeap();
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
      const nx = cx + dx;
      const ny = cy + dy;
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
    rawPath.push({
      x: cx * nav.cellSize + nav.cellSize / 2,
      y: cy * nav.cellSize + nav.cellSize / 2
    });
    at = cameFrom[at];
  }
  rawPath.reverse();

  const endIsSafe = insideWorld(endWorld, radius, map) && !pointBlockedByBuilding(endWorld, radius, map);
  const safeEnd = endIsSafe
    ? { x: endWorld.x, y: endWorld.y }
    : rawPath[rawPath.length - 1];
  const fullPath = [{ x: startWorld.x, y: startWorld.y }, ...rawPath, safeEnd];

  const smoothed = [fullPath[0]];
  let anchorIdx = 0;
  for (let i = 2; i < fullPath.length; i += 1) {
    if (!segmentClearForCircle(fullPath[anchorIdx], fullPath[i], radius, map)) {
      smoothed.push(fullPath[i - 1]);
      anchorIdx = i - 1;
    }
  }
  if (segmentClearForCircle(smoothed[smoothed.length - 1], fullPath[fullPath.length - 1], radius, map)) {
    smoothed.push(fullPath[fullPath.length - 1]);
  }
  return smoothed;
}

function pathLength(path) {
  let len = 0;
  for (let i = 1; i < path.length; i += 1) {
    len += distance(path[i - 1], path[i]);
  }
  return len;
}

function clampPathToLength(path, maxLength) {
  if (path.length < 2 || maxLength <= 0) {
    return path.length ? [{ x: path[0].x, y: path[0].y }] : [];
  }
  const result = [{ x: path[0].x, y: path[0].y }];
  let acc = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const segDist = distance(a, b);
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

function pointAtDistanceAlongPath(path, targetDistance) {
  if (!path.length) return { x: 0, y: 0 };
  if (targetDistance <= 0 || path.length === 1) {
    return { x: path[0].x, y: path[0].y };
  }
  let acc = 0;
  for (let i = 1; i < path.length; i += 1) {
    const a = path[i - 1];
    const b = path[i];
    const segDist = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + segDist >= targetDistance) {
      const t = segDist > 0 ? (targetDistance - acc) / segDist : 0;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += segDist;
  }
  return { x: path[path.length - 1].x, y: path[path.length - 1].y };
}

function interpolateMotionEntry(entry, elapsedMs) {
  if (!entry?.samples?.length) {
    return entry?.end ? { x: entry.end.x, y: entry.end.y } : null;
  }
  if (elapsedMs <= 0) {
    return { x: entry.samples[0].x, y: entry.samples[0].y };
  }

  const samples = entry.samples;
  for (let i = 1; i < samples.length; i += 1) {
    const previous = samples[i - 1];
    const current = samples[i];
    if (elapsedMs <= current.timeMs) {
      const duration = Math.max(current.timeMs - previous.timeMs, 1);
      const t = clamp((elapsedMs - previous.timeMs) / duration, 0, 1);
      return lerpPoint(previous, current, t);
    }
  }

  const last = samples[samples.length - 1];
  return { x: last.x, y: last.y };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

function resolvePlayerMovementSlides(players, sim, proposed, radius, map) {
  const adjusted = Object.fromEntries(
    players.map((player) => [player.id, { ...proposed[player.id] }])
  );

  for (let iteration = 0; iteration < 10; iteration += 1) {
    let changed = false;

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

        const aCurrent = aState.current;
        const bCurrent = bState.current;
        const aNext = adjusted[a.id];
        const bNext = adjusted[b.id];

        let diff = subtract(aNext, bNext);
        let dist = Math.hypot(diff.x, diff.y);
        if (dist >= radius * 2 - 0.01) {
          continue;
        }

        let normal;
        if (dist > 1e-6) {
          normal = scale(diff, 1 / dist);
        } else {
          const relativeStart = subtract(aCurrent, bCurrent);
          normal = normalizeVector(
            Math.hypot(relativeStart.x, relativeStart.y) > 1e-6
              ? relativeStart
              : { x: a.id < b.id ? 1 : -1, y: 0 },
            { x: 1, y: 0 }
          );
          dist = 0;
        }

        const aTravel = distance(aCurrent, aNext);
        const bTravel = distance(bCurrent, bNext);
        const totalTravel = aTravel + bTravel;
        const aShare = totalTravel > 1e-6 ? aTravel / totalTravel : 0.5;
        const bShare = totalTravel > 1e-6 ? bTravel / totalTravel : 0.5;
        const overlap = radius * 2 - dist + 0.02;

        const aCorrection = scale(normal, overlap * aShare);
        const bCorrection = scale(normal, -overlap * bShare);
        const newANext = furthestClearPointAlongDelta(aNext, aCorrection, radius, map);
        const newBNext = furthestClearPointAlongDelta(bNext, bCorrection, radius, map);

        if (
          distance(newANext, adjusted[a.id]) > 0.25 ||
          distance(newBNext, adjusted[b.id]) > 0.25
        ) {
          adjusted[a.id] = newANext;
          adjusted[b.id] = newBNext;
          changed = true;
        }
      }
    }

    if (!changed) {
      break;
    }
  }

  return adjusted;
}

function movingCirclesCollisionTime(aStart, aEnd, bStart, bEnd, minDistance) {
  const relativeStart = subtract(aStart, bStart);
  const relativeVelocity = subtract(subtract(aEnd, aStart), subtract(bEnd, bStart));
  const minDistanceSq = minDistance * minDistance;
  const startDistanceSq =
    relativeStart.x * relativeStart.x + relativeStart.y * relativeStart.y;

  if (startDistanceSq <= minDistanceSq) {
    return 0;
  }

  const a =
    relativeVelocity.x * relativeVelocity.x + relativeVelocity.y * relativeVelocity.y;
  const b =
    2 * (relativeStart.x * relativeVelocity.x + relativeStart.y * relativeVelocity.y);
  const c = startDistanceSq - minDistanceSq;

  if (almostEqual(a, 0)) {
    return null;
  }

  const discriminant = b * b - 4 * a * c;
  if (discriminant < 0) {
    return null;
  }

  const sqrtDiscriminant = Math.sqrt(discriminant);
  const t1 = (-b - sqrtDiscriminant) / (2 * a);
  const t2 = (-b + sqrtDiscriminant) / (2 * a);
  const candidates = [t1, t2].filter((value) => value >= 0 && value <= 1);
  if (!candidates.length) {
    return null;
  }
  return Math.min(...candidates);
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
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  const samples = Math.max(1, Math.ceil(length / Math.max(radius * 0.5, 1)));
  for (let i = 1; i < samples; i += 1) {
    const t = i / samples;
    const probe = { x: start.x + dx * t, y: start.y + dy * t };
    if (!insideWorld(probe, radius, map) || pointBlockedByBuilding(probe, radius, map)) {
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

function currentMovementPosition(room, player, timestampMs = nowMs()) {
  if (!room.round?.currentTurn?.movement || room.phase !== "movement") {
    return { x: player.x, y: player.y };
  }

  const movement = room.round.currentTurn.movement;
  const entry = movement.byPlayer?.[player.id];
  if (!entry) {
    return { x: player.x, y: player.y };
  }

  const activeDuration = Math.max(entry.haltedAtMs || movement.durationMs, 1);
  const elapsed = clamp(timestampMs - movement.startedAt, 0, activeDuration);
  return interpolateMotionEntry(entry, elapsed) || { x: player.x, y: player.y };
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

function createRoom(code, mode = "turn") {
  return {
    code,
    createdAt: nowMs(),
    mode,
    players: new Map(),
    hostId: null,
    settings: {
      mapGridSize: CONFIG.defaultMapGridSize
    },
    phase: "lobby",
    phaseStartedAt: nowMs(),
    phaseEndsAt: null,
    phaseLabel: "Waiting for players",
    match: null,
    round: null,
    lastRoundSummary: null,
    lastMatchSummary: null,
    version: 0,
    waiters: []
  };
}

function notifyRoomChange(room) {
  if (!room) return;
  room.version += 1;
  const waiters = room.waiters;
  room.waiters = [];
  for (const waiter of waiters) {
    clearTimeout(waiter.timer);
    waiter.resolve();
  }
}

function waitForRoomVersion(room, sinceVersion, timeoutMs) {
  return new Promise((resolve) => {
    if (!room || room.version > sinceVersion) {
      resolve();
      return;
    }
    const waiter = { resolve, timer: null };
    waiter.timer = setTimeout(() => {
      const idx = room.waiters.indexOf(waiter);
      if (idx >= 0) room.waiters.splice(idx, 1);
      resolve();
    }, timeoutMs);
    room.waiters.push(waiter);
  });
}

function connectedPlayers(room) {
  return Array.from(room.players.values()).filter((player) => player.connected);
}

function ensureHost(room) {
  if (room.hostId) {
    const currentHost = room.players.get(room.hostId);
    if (currentHost && currentHost.connected) {
      return currentHost;
    }
  }

  const nextHost = Array.from(room.players.values()).find((player) => player.connected) || null;
  room.hostId = nextHost ? nextHost.id : null;
  return nextHost;
}

function setPhase(room, phase, durationMs, label) {
  const current = nowMs();
  room.phase = phase;
  room.phaseStartedAt = current;
  room.phaseDurationMs = durationMs;
  room.phaseEndsAt = durationMs === null ? null : current + durationMs;
  room.phaseLabel = label;
  notifyRoomChange(room);
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

function sanitizePlayerName(rawName) {
  return String(rawName || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 20);
}

function sanitizeMapGridSize(rawValue) {
  const parsed = Number(rawValue);
  if (parsed === 3 || parsed === 4 || parsed === 10) return parsed;
  return 2;
}

function generateMap(mapGridSize) {
  const gridSize = sanitizeMapGridSize(mapGridSize);
  const buildingTarget = Math.min(
    400,
    Math.round(CONFIG.defaultBuildingCount * ((gridSize * gridSize) / 4))
  );
  const map = {
    id: `map-${globalMapSerial++}`,
    width: CONFIG.screenSize * gridSize,
    height: CONFIG.screenSize * gridSize,
    buildings: []
  };

  const corridorPadding = 28;
  for (let attempt = 0; attempt < 8000 && map.buildings.length < buildingTarget; attempt += 1) {
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
      if (rotatedRectanglesOverlap(building, other, corridorPadding)) {
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
  player.planFinal = false;
  player.pendingBrSpawn = false;
}

function beginLobbyCountdown(room) {
  setPhase(room, "lobby_countdown", CONFIG.lobbyCountdownMs, "Match starts soon");
}

function pickRandomWalkableTarget(origin, map) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const angle = Math.random() * Math.PI * 2;
    const dist = (0.4 + Math.random() * 0.6) * CONFIG.moveRange;
    const candidate = {
      x: clamp(origin.x + Math.cos(angle) * dist, CONFIG.playerRadius, map.width - CONFIG.playerRadius),
      y: clamp(origin.y + Math.sin(angle) * dist, CONFIG.playerRadius, map.height - CONFIG.playerRadius)
    };
    if (!pointBlockedByBuilding(candidate, CONFIG.playerRadius, map)) {
      return candidate;
    }
  }
  return { x: origin.x, y: origin.y };
}

function pickClearAimDirection(origin, map) {
  let bestDir = { x: 0, y: -1 };
  let bestDist = 0;
  const baseAngle = Math.random() * Math.PI * 2;
  for (let i = 0; i < 8; i += 1) {
    const angle = baseAngle + (i / 8) * Math.PI * 2 + (Math.random() - 0.5) * 0.3;
    const dir = { x: Math.cos(angle), y: Math.sin(angle) };
    const wallHit = raycastToMap(origin, dir, map);
    if (wallHit.distance > bestDist) {
      bestDist = wallHit.distance;
      bestDir = dir;
    }
  }
  return bestDir;
}

function generateBotPlan(room, bot) {
  const map = room.round.map;
  const enemies = room.match.participantIds
    .map((id) => room.players.get(id))
    .filter((p) => p && p.id !== bot.id && p.roundAlive && !p.disconnected);
  const visible = enemies.filter((e) => lineOfSightClear(bot, e, map));

  let aimDir;
  let moveTarget;

  if (visible.length > 0) {
    const target = visible.reduce(
      (best, e) => (distance(bot, e) < distance(bot, best) ? e : best),
      visible[0]
    );
    let dx = target.x - bot.x;
    let dy = target.y - bot.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    const wobble = (Math.random() - 0.5) * 0.06;
    const cos = Math.cos(wobble);
    const sin = Math.sin(wobble);
    aimDir = { x: dx * cos - dy * sin, y: dx * sin + dy * cos };

    const idealRange = CONFIG.moveRange * 0.45;
    const gap = len - idealRange;
    const advanceMag = Math.sign(gap) * Math.min(Math.abs(gap), CONFIG.moveRange * 0.6);
    const sign = Math.random() < 0.5 ? 1 : -1;
    const strafeDist = (0.2 + Math.random() * 0.35) * CONFIG.moveRange;
    moveTarget = {
      x: clamp(bot.x + dx * advanceMag + (-dy * sign) * strafeDist, CONFIG.playerRadius, map.width - CONFIG.playerRadius),
      y: clamp(bot.y + dy * advanceMag + (dx * sign) * strafeDist, CONFIG.playerRadius, map.height - CONFIG.playerRadius)
    };
    if (pointBlockedByBuilding(moveTarget, CONFIG.playerRadius, map)) {
      moveTarget = {
        x: clamp(bot.x + dx * advanceMag, CONFIG.playerRadius, map.width - CONFIG.playerRadius),
        y: clamp(bot.y + dy * advanceMag, CONFIG.playerRadius, map.height - CONFIG.playerRadius)
      };
    }
    if (pointBlockedByBuilding(moveTarget, CONFIG.playerRadius, map)) {
      moveTarget = pickRandomWalkableTarget(bot, map);
    }
  } else if (enemies.length > 0) {
    const closest = enemies.reduce(
      (best, e) => (distance(bot, e) < distance(bot, best) ? e : best),
      enemies[0]
    );
    let dx = closest.x - bot.x;
    let dy = closest.y - bot.y;
    const len = Math.hypot(dx, dy);
    if (len > 0) { dx /= len; dy /= len; }
    const advance = Math.min(len, CONFIG.moveRange) * (0.7 + Math.random() * 0.3);
    moveTarget = {
      x: clamp(bot.x + dx * advance, CONFIG.playerRadius, map.width - CONFIG.playerRadius),
      y: clamp(bot.y + dy * advance, CONFIG.playerRadius, map.height - CONFIG.playerRadius)
    };
    if (pointBlockedByBuilding(moveTarget, CONFIG.playerRadius, map)) {
      moveTarget = pickRandomWalkableTarget(bot, map);
    }
    aimDir = { x: dx, y: dy };
    const wallHit = raycastToMap(bot, aimDir, map);
    if (wallHit.distance < CONFIG.playerRadius * 4) {
      aimDir = pickClearAimDirection(bot, map);
    }
  } else {
    moveTarget = pickRandomWalkableTarget(bot, map);
    aimDir = pickClearAimDirection(bot, map);
  }

  return { moveTarget, aimDir };
}

function pickBrSpawn(map) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const candidate = {
      x: 120 + Math.random() * (map.width - 240),
      y: 120 + Math.random() * (map.height - 240)
    };
    if (!insideWorld(candidate, CONFIG.playerRadius, map)) continue;
    if (pointBlockedByBuilding(candidate, CONFIG.playerRadius + 20, map)) continue;
    return candidate;
  }
  return { x: CONFIG.playerRadius + 40, y: CONFIG.playerRadius + 40 };
}

function addBrParticipant(room, player) {
  if (!room.match) {
    startBrMatch(room);
    return;
  }
  if (!room.match.participantIds.includes(player.id)) {
    room.match.participantIds.push(player.id);
  }
  room.match.kills[player.id] = 0;
  room.match.totalSurvivalMs[player.id] = 0;
  player.roundAlive = false;
  player.spectating = true;
  player.pendingBrSpawn = true;
}

function startBrMatch(room) {
  const participants = connectedPlayers(room);
  room.match = {
    id: `match-br-${globalMatchSerial++}`,
    participantIds: participants.map((p) => p.id),
    roundWins: Object.fromEntries(participants.map((p) => [p.id, 0])),
    totalSurvivalMs: Object.fromEntries(participants.map((p) => [p.id, 0])),
    kills: Object.fromEntries(participants.map((p) => [p.id, 0])),
    currentRoundNumber: 0
  };
  room.lastRoundSummary = null;
  room.lastMatchSummary = null;
  startBrRound(room);
}

function startBrRound(room) {
  room.match.currentRoundNumber += 1;
  const fixedSize = room.settings.fixedMapGridSize || null;
  let gridSize;
  if (fixedSize) {
    gridSize = fixedSize;
  } else {
    const count = room.match.participantIds.length;
    gridSize = clamp(Math.ceil(Math.sqrt(Math.max(count, 1))), 2, 10);
  }
  room.settings.mapGridSize = gridSize;
  const map = generateMap(gridSize);
  getNavGrid(map);
  const participantIds = room.match.participantIds;
  room.round = {
    number: room.match.currentRoundNumber,
    map,
    turnNumber: 0,
    roundStartedAt: null,
    planningVisibility: {},
    currentTurn: null
  };
  for (const playerId of participantIds) {
    const player = room.players.get(playerId);
    if (!player) continue;
    resetPlayerForRound(player, pickBrSpawn(map));
  }
  startPlanning(room);
}

function finalizeBrMatch(room) {
  const kills = room.match.kills || {};
  let winnerId = null;
  let top = -1;
  for (const id of room.match.participantIds) {
    const k = kills[id] || 0;
    if (k > top) {
      top = k;
      winnerId = id;
    }
  }
  room.lastMatchSummary = {
    winnerId,
    scoreboard: room.match.participantIds
      .map((id) => {
        const p = room.players.get(id);
        return {
          id,
          name: p ? p.name : "?",
          wins: 0,
          survivalMs: 0,
          kills: kills[id] || 0
        };
      })
      .sort((a, b) => b.kills - a.kills)
  };
  setPhase(room, "match_end", 5_000, "Match over");
}

function startMatch(room) {
  ensureHost(room);
  const participants = connectedPlayers(room).slice(0, CONFIG.maxPlayers);
  const minRequired = room.testMode ? 1 : CONFIG.minPlayers;
  if (participants.length < minRequired) {
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
  const map = generateMap(room.settings.mapGridSize);
  getNavGrid(map);
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
    if (room.mode === "br" && !player.roundAlive && room.round.map && !player.disconnected) {
      resetPlayerForRound(player, pickBrSpawn(room.round.map));
    }
    player.plan = createFreshPlan(player);
    player.planFinal = false;
    if (player.bot && player.roundAlive && !player.disconnected && room.round.map) {
      const botPlan = generateBotPlan(room, player);
      player.plan = {
        moveTarget: botPlan.moveTarget,
        aimDir: botPlan.aimDir,
        ready: true,
        updatedAt: nowMs()
      };
      player.lastAimDir = botPlan.aimDir;
      player.planFinal = true;
    }
    room.round.currentTurn.plans[player.id] = player.plan;
    room.round.planningVisibility[player.id] = visibleEnemiesForPlayer(room, player.id);
  }

  setPhase(room, "planning", CONFIG.planningMs, `Turn ${room.round.turnNumber}`);
}

function normalizedMoveTarget(player, moveTarget) {
  return {
    x: Number(moveTarget.x),
    y: Number(moveTarget.y)
  };
}

function planMovePath(map, startWorld, endWorld, radius, maxLength) {
  const full = findPath(map, startWorld, endWorld, radius);
  if (!full || full.length < 2) {
    return [{ x: startWorld.x, y: startWorld.y }];
  }
  return clampPathToLength(full, maxLength);
}

function simulateMovement(room, actionMap) {
  const map = room.round.map;
  const radius = CONFIG.playerRadius;
  const speedPxMs = CONFIG.moveRange / CONFIG.movementMs;
  const bulletSpeedPxMs = CONFIG.bulletSpeed / 1000;
  const players = room.match.participantIds
    .map((playerId) => room.players.get(playerId))
    .filter(Boolean);

  const sim = {};
  let maxFinishMs = 0;
  for (const player of players) {
    const action = actionMap[player.id];
    const startPos = { x: player.x, y: player.y };
    let path = [startPos];
    let pathLen = 0;
    const wantsMove = player.roundAlive && !player.disconnected && action && distance(player, action.moveEnd) > 1;
    if (wantsMove) {
      path = planMovePath(map, startPos, action.moveEnd, radius, CONFIG.moveRange);
      pathLen = pathLength(path);
    }
    const finishMs = pathLen / speedPxMs;
    const aimDir = action ? action.aimDir : (player.lastAimDir || { x: 0, y: -1 });
    sim[player.id] = {
      id: player.id,
      path,
      pathLen,
      finishMs,
      aimDir,
      startPos,
      alive: !!player.roundAlive && !player.disconnected,
      willShoot: !!action && !!player.roundAlive && !player.disconnected,
      deathAtMs: null,
      hitByBulletId: null,
      hadAction: !!action
    };
    if (finishMs > maxFinishMs) maxFinishMs = finishMs;
  }

  function posAt(playerId, tMs) {
    const s = sim[playerId];
    const deathCap = s.deathAtMs !== null ? s.deathAtMs : Infinity;
    const travelMs = Math.min(tMs, s.finishMs, deathCap);
    return pointAtDistanceAlongPath(s.path, Math.max(0, travelMs) * speedPxMs);
  }

  const bullets = [];
  let bulletSerial = 1;
  const shooters = players.slice();
  const uniformFireTimeMs = CONFIG.movementMs;

  for (const shooter of shooters) {
    const s = sim[shooter.id];
    if (!s.willShoot) continue;
    const fireTimeMs = uniformFireTimeMs;
    if (s.deathAtMs !== null && s.deathAtMs <= fireTimeMs) continue;

    const origin = posAt(shooter.id, fireTimeMs);
    const direction = normalizeVector(s.aimDir, { x: 0, y: -1 });
    const wallHit = raycastToMap(origin, direction, map);
    const wallDist = wallHit.distance;
    const wallTimeMs = wallDist / bulletSpeedPxMs;

    let hitVictim = null;
    let hitTimeMs = wallTimeMs;
    let hitDist = wallDist;

    for (const target of players) {
      if (target.id === shooter.id) continue;
      const t = sim[target.id];
      if (!t.alive) continue;
      if (t.deathAtMs !== null && t.deathAtMs <= fireTimeMs) continue;

      const maxDt = Math.min(wallTimeMs, hitTimeMs);
      const samples = 80;
      let found = null;
      for (let k = 1; k <= samples; k++) {
        const dtMs = (k / samples) * maxDt;
        const bulletPos = {
          x: origin.x + direction.x * dtMs * bulletSpeedPxMs,
          y: origin.y + direction.y * dtMs * bulletSpeedPxMs
        };
        const targetTimeMs = fireTimeMs + dtMs;
        if (t.deathAtMs !== null && targetTimeMs >= t.deathAtMs) break;
        const targetPos = posAt(target.id, targetTimeMs);
        const d = Math.hypot(bulletPos.x - targetPos.x, bulletPos.y - targetPos.y);
        if (d < radius) { found = dtMs; break; }
      }
      if (found !== null && found < hitTimeMs) {
        hitTimeMs = found;
        hitDist = found * bulletSpeedPxMs;
        hitVictim = target.id;
      }
    }

    const bulletId = `bullet-${room.round.number}-${room.round.turnNumber}-${bulletSerial++}`;
    bullets.push({
      id: bulletId,
      shooterId: shooter.id,
      fireTimeMs,
      origin: { x: origin.x, y: origin.y },
      direction: { x: direction.x, y: direction.y },
      wallDistance: wallDist,
      wallPoint: wallHit.hitPoint,
      wallTimeMs,
      stopTimeMs: hitTimeMs,
      stopDistance: hitDist,
      victimId: hitVictim
    });

    if (hitVictim) {
      const v = sim[hitVictim];
      v.deathAtMs = fireTimeMs + hitTimeMs;
      v.hitByBulletId = bulletId;
    }
  }

  const byPlayer = {};
  const kills = [];
  const elapsedBeforeShots = room.round.roundStartedAt ? nowMs() - room.round.roundStartedAt : 0;

  for (const player of players) {
    const s = sim[player.id];
    const endTimeMs = s.deathAtMs !== null ? Math.min(s.deathAtMs, s.finishMs) : s.finishMs;
    const samples = [{ timeMs: 0, x: s.startPos.x, y: s.startPos.y }];
    if (s.pathLen > 0 && endTimeMs > 0) {
      const stepCount = Math.max(1, Math.ceil(s.pathLen / 4));
      for (let k = 1; k <= stepCount; k++) {
        const dist = (k / stepCount) * s.pathLen;
        const tMs = dist / speedPxMs;
        if (tMs > endTimeMs + 0.5) break;
        const p = pointAtDistanceAlongPath(s.path, dist);
        samples.push({ timeMs: Math.round(tMs), x: p.x, y: p.y });
      }
    }
    const finalPos = pointAtDistanceAlongPath(s.path, Math.max(0, endTimeMs) * speedPxMs);
    const last = samples[samples.length - 1];
    if (last.timeMs !== Math.round(endTimeMs)) {
      samples.push({ timeMs: Math.round(endTimeMs), x: finalPos.x, y: finalPos.y });
    }
    byPlayer[player.id] = {
      start: s.startPos,
      end: { x: finalPos.x, y: finalPos.y },
      haltedAtMs: Math.round(endTimeMs),
      hadAction: s.hadAction,
      samples
    };

    if (s.deathAtMs !== null && player.roundAlive) {
      player.roundAlive = false;
      player.spectating = true;
      player.roundDeathAtMs = elapsedBeforeShots + s.deathAtMs;
      const bullet = bullets.find((b) => b.victimId === player.id);
      if (bullet) {
        kills.push({
          shooterId: bullet.shooterId,
          victimId: player.id,
          timeMs: Math.round(s.deathAtMs),
          bulletId: bullet.id
        });
        if (room.mode === "br" && room.match) {
          if (room.match.kills[bullet.shooterId] !== undefined) {
            room.match.kills[bullet.shooterId] += 1;
          }
          room.match.kills[player.id] = 0;
        }
      }
    }

    player.x = finalPos.x;
    player.y = finalPos.y;
  }

  let lastEventMs = maxFinishMs;
  for (const b of bullets) {
    const end = b.fireTimeMs + b.stopTimeMs;
    if (end > lastEventMs) lastEventMs = end;
  }
  const durationMs = Math.max(Math.round(lastEventMs + 600), 800);

  return { byPlayer, bullets, kills, durationMs };
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
    const reachable = {
      x: clamp(normalizedTarget.x, CONFIG.playerRadius, room.round.map.width - CONFIG.playerRadius),
      y: clamp(normalizedTarget.y, CONFIG.playerRadius, room.round.map.height - CONFIG.playerRadius)
    };
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
  const result = simulateMovement(room, actionMap);
  room.round.currentTurn.movement = {
    startedAt: nowMs(),
    durationMs: result.durationMs,
    byPlayer: result.byPlayer,
    bullets: result.bullets,
    kills: result.kills,
    actionMap
  };
  setPhase(room, "movement", result.durationMs, "Action");
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
  ensureHost(room);

  for (const player of room.players.values()) {
    if (player.bot) continue;
    if (player.connected && now - player.lastSeenAt > CONFIG.pollGraceMs) {
      player.connected = false;
      player.disconnected = true;
    }
  }

  if (!room.match) {
    for (const [playerId, player] of room.players.entries()) {
      if (player.bot) continue;
      if (!player.connected && now - player.lastSeenAt > CONFIG.lobbyCleanupMs) {
        sessions.delete(player.token);
        room.players.delete(playerId);
      }
    }
  }

  const connectedCount = connectedPlayers(room).length;

  if (room.phase === "lobby") {
    return;
  }

  if (room.phase === "lobby_countdown") {
    const minRequired = room.testMode ? 1 : CONFIG.minPlayers;
    if (connectedCount < minRequired) {
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

  if (room.phase === "planning" && room.phaseEndsAt) {
    const participants = room.match.participantIds
      .map((id) => room.players.get(id))
      .filter((p) => p && p.roundAlive && !p.disconnected);
    const allReady = participants.length > 0 && participants.every((p) => p.planFinal);
    const timedOut = now >= room.phaseEndsAt + CONFIG.planningMaxWaitMs;
    if (allReady || timedOut) {
      beginMovement(room);
      return;
    }
  }

  if (room.phase === "movement" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    const aliveCount = room.match.participantIds
      .map((playerId) => room.players.get(playerId))
      .filter((player) => player && player.roundAlive).length;
    const soloTest = room.testMode && room.match.participantIds.length === 1;
    if (room.mode === "br") {
      const target = room.settings.killTarget || 5;
      const top = Math.max(0, ...Object.values(room.match.kills || {}));
      if (top >= target) {
        finalizeBrMatch(room);
      } else {
        startPlanning(room);
      }
    } else if (aliveCount <= 1 && !soloTest) {
      finalizeRound(room);
    } else {
      startPlanning(room);
    }
    return;
  }

  if (room.phase === "round_end" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    if (room.match.currentRoundNumber >= (room.settings.totalRounds || CONFIG.totalRounds)) {
      finishMatch(room);
    } else {
      startRound(room);
    }
    return;
  }

  if (room.phase === "match_end" && room.phaseEndsAt && now >= room.phaseEndsAt) {
    if (room.mode === "br") {
      startBrMatch(room);
    } else {
      returnRoomToLobby(room);
    }
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
  const viewerPosition = currentMovementPosition(room, viewer);
  const targetPosition = currentMovementPosition(room, target);
  return lineOfSightClear(viewerPosition, targetPosition, room.round.map);
}

function serializePlayerForViewer(room, viewer, target) {
  const inCurrentMatch = room.match ? room.match.participantIds.includes(target.id) : false;
  const visibleToYou = shouldRevealPlayerToViewer(room, viewer, target);
  const position = currentMovementPosition(room, target);
  return {
    id: target.id,
    name: target.name,
    color: target.color,
    connected: target.connected,
    disconnected: target.disconnected,
    alive: inCurrentMatch ? !!target.roundAlive : false,
    spectating: inCurrentMatch ? !!target.spectating : false,
    x: visibleToYou ? position.x : null,
    y: visibleToYou ? position.y : null,
    wins: room.match ? room.match.roundWins[target.id] || 0 : 0,
    survivalMs: room.match ? room.match.totalSurvivalMs[target.id] || 0 : 0,
    lastAimDir: visibleToYou ? target.lastAimDir : null,
    visibleToYou
  };
}

function buildState(player) {
  const room = rooms.get(player.roomCode);
  ensureHost(room);
  const players = Array.from(room.players.values());

  return {
    ok: true,
    serverNow: nowMs(),
    config: {
      moveRange: CONFIG.moveRange,
      playerRadius: CONFIG.playerRadius,
      planningMs: CONFIG.planningMs,
      movementMs: CONFIG.movementMs,
      bulletSpeed: CONFIG.bulletSpeed,
      screenSize: CONFIG.screenSize
    },
    room: {
      code: room.code,
      hostId: room.hostId,
      settings: room.settings,
      mode: room.mode,
      phase: room.phase,
      phaseLabel: room.phaseLabel,
      phaseDurationMs: room.phaseDurationMs || null,
      connectedCount: connectedPlayers(room).length,
      playerCount: players.length,
      minPlayers: CONFIG.minPlayers,
      maxPlayers: CONFIG.maxPlayers
    },
    you: {
      id: player.id,
      name: player.name,
      isHost: player.id === room.hostId,
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
          mode: room.mode,
          currentRound: room.match.currentRoundNumber,
          totalRounds: room.mode === "br" ? null : (room.settings.totalRounds || CONFIG.totalRounds),
          turnNumber: room.round ? room.round.turnNumber : 0,
          participantIds: room.match.participantIds,
          kills: room.match.kills || null,
          map: room.round
            ? {
                id: room.round.map.id,
                width: room.round.map.width,
                height: room.round.map.height,
                buildings: room.round.map.buildings.map(serializeBuilding)
              }
            : null,
          movement: room.round?.currentTurn?.movement || null,
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

function findAvailableBrRoom() {
  for (const room of rooms.values()) {
    if (room.mode === "br" && !room.private && room.players.size < CONFIG.brMaxPlayers) {
      return room;
    }
  }
  return null;
}

async function handleJoin(request, response) {
  const body = await readJsonBody(request);
  const requestedMode = body.mode === "br" ? "br" : "turn";
  const requestedName = sanitizePlayerName(body.name);
  const requestedMapGridSize = sanitizeMapGridSize(body.mapGridSize);
  const isPractice = !!body.practice;

  let room = null;
  let desiredCode = "";
  if (requestedMode === "br" && !isPractice) {
    room = findAvailableBrRoom();
    desiredCode = room ? room.code : "";
  } else if (requestedMode === "turn") {
    desiredCode = sanitizeRoomCode(body.roomCode);
    if (body.roomCode && desiredCode.length !== CONFIG.roomCodeLength) {
      json(response, 400, { ok: false, error: "Room codes must be 4 characters." });
      return;
    }
    room = desiredCode ? rooms.get(desiredCode) : null;
  }

  if (
    room &&
    room.mode === "turn" &&
    room.match &&
    !["lobby", "lobby_countdown", "match_end"].includes(room.phase)
  ) {
    json(response, 409, { ok: false, error: "Match already in progress." });
    return;
  }

  if (!room) {
    const code = desiredCode || generateRoomCode();
    room = createRoom(code, requestedMode);
    const rawRounds = Number(body.totalRounds);
    const totalRounds = [1, 3, 5, 7].includes(rawRounds) ? rawRounds : CONFIG.totalRounds;
    const rawKillTarget = Number(body.killTarget);
    const killTargetOverride = [3, 5, 7, 10, 15, 20].includes(rawKillTarget) ? rawKillTarget : null;
    const fixedMapGridSize = isPractice ? 3 : null;
    room.settings = {
      mapGridSize:
        requestedMode === "br"
          ? (fixedMapGridSize || 2)
          : requestedMapGridSize || CONFIG.defaultMapGridSize,
      fixedMapGridSize,
      killTarget: requestedMode === "br" ? (killTargetOverride || CONFIG.brKillTarget) : 0,
      totalRounds: requestedMode === "br" ? null : totalRounds
    };
    if (isPractice) room.private = true;
    rooms.set(code, room);
  }

  const playerCap = room.mode === "br" ? CONFIG.brMaxPlayers : CONFIG.maxPlayers;
  if (room.players.size >= playerCap) {
    json(response, 409, { ok: false, error: "Room is full." });
    return;
  }

  const serial = globalPlayerSerial++;
  const player = {
    id: `player-${serial}`,
    token: randomId(24),
    roomCode: room.code,
    name: requestedName || generateGuestName(room),
    color: generateColor(serial),
    connected: true,
    disconnected: false,
    lastSeenAt: nowMs(),
    x: CONFIG.screenSize / 2,
    y: CONFIG.screenSize / 2,
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

  if (room.mode === "br") {
    addBrParticipant(room, player);
  }

  const botCount = Number(body.bots) || 0;
  if (botCount > 0 && (isPractice || room.players.size === 1)) {
    for (let i = 0; i < Math.min(botCount, 12); i += 1) {
      addBotToRoom(room);
    }
  }

  notifyRoomChange(room);
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
  if (body.final === true) {
    player.planFinal = true;
  }
  if (room.round.currentTurn) {
    room.round.currentTurn.plans[player.id] = nextPlan;
  }

  json(response, 200, { ok: true, plan: nextPlan, final: !!player.planFinal });
}

async function handleRespawn(request, response) {
  const body = await readJsonBody(request);
  const player = getPlayerByToken(body.token);
  if (!player) {
    json(response, 401, { ok: false, error: "Invalid session." });
    return;
  }
  const room = rooms.get(player.roomCode);
  if (!room || room.mode !== "br") {
    json(response, 409, { ok: false, error: "Respawn only allowed in battle royale." });
    return;
  }
  player.lastSeenAt = nowMs();
  player.connected = true;
  player.disconnected = false;
  if (player.roundAlive) {
    json(response, 200, { ok: true, already: true });
    return;
  }
  if (!room.round || !room.round.map) {
    json(response, 409, { ok: false, error: "Not currently in a round." });
    return;
  }
  const spawn = pickBrSpawn(room.round.map);
  resetPlayerForRound(player, spawn);
  if (room.match) {
    if (!room.match.participantIds.includes(player.id)) {
      room.match.participantIds.push(player.id);
    }
    room.match.kills[player.id] = 0;
  }
  notifyRoomChange(room);
  json(response, 200, { ok: true });
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
  notifyRoomChange(rooms.get(player.roomCode));
  json(response, 200, { ok: true });
}

function addBotToRoom(room) {
  const cap = room.mode === "br" ? CONFIG.brMaxPlayers : CONFIG.maxPlayers;
  if (room.players.size >= cap) return null;
  const serial = globalPlayerSerial++;
  const bot = {
    id: `bot-${serial}`,
    token: `bot-token-${serial}`,
    roomCode: room.code,
    name: `Bot ${serial}`,
    color: generateColor(serial),
    connected: true,
    disconnected: false,
    bot: true,
    lastSeenAt: nowMs(),
    x: CONFIG.screenSize / 2,
    y: CONFIG.screenSize / 2,
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
  room.players.set(bot.id, bot);
  if (room.mode === "br") {
    addBrParticipant(room, bot);
  }
  return bot;
}

async function handleAddBot(request, response) {
  const body = await readJsonBody(request);
  const player = getPlayerByToken(body.token);
  if (!player) {
    json(response, 401, { ok: false, error: "Invalid session." });
    return;
  }
  const room = rooms.get(player.roomCode);
  if (!room) {
    json(response, 404, { ok: false, error: "Room not found." });
    return;
  }
  ensureHost(room);
  if (player.id !== room.hostId) {
    json(response, 403, { ok: false, error: "Only the host can add bots." });
    return;
  }
  const bot = addBotToRoom(room);
  if (!bot) {
    json(response, 409, { ok: false, error: "Room is full." });
    return;
  }
  notifyRoomChange(room);
  json(response, 200, { ok: true, botId: bot.id });
}

async function handleStart(request, response) {
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
  ensureHost(room);

  if (player.id !== room.hostId) {
    json(response, 403, { ok: false, error: "Only the host can start the game." });
    return;
  }

  if (room.phase !== "lobby") {
    json(response, 409, { ok: false, error: "The room is not in the lobby." });
    return;
  }

  const testMode = !!body.testMode;
  const minRequired = testMode ? 1 : CONFIG.minPlayers;
  if (connectedPlayers(room).length < minRequired) {
    json(response, 409, { ok: false, error: "At least 2 players are required." });
    return;
  }

  room.testMode = testMode;
  beginLobbyCountdown(room);
  json(response, 200, { ok: true });
}

async function handleState(request, response, urlObject) {
  const token = urlObject.searchParams.get("token");
  const sinceVersionRaw = urlObject.searchParams.get("version");
  const sinceVersion = sinceVersionRaw === null ? -1 : Number(sinceVersionRaw);
  const player = getPlayerByToken(token);
  if (!player) {
    json(response, 401, { ok: false, error: "Invalid session." });
    return;
  }
  player.lastSeenAt = nowMs();
  player.connected = true;
  player.disconnected = false;

  const room = rooms.get(player.roomCode);
  if (room && Number.isFinite(sinceVersion) && sinceVersion >= 0) {
    await waitForRoomVersion(room, sinceVersion, 6000);
    player.lastSeenAt = nowMs();
  }

  const state = buildState(player);
  state.version = room ? room.version : 0;
  json(response, 200, state);
}

const server = http.createServer(async (request, response) => {
  try {
    const urlObject = new URL(request.url, `http://${request.headers.host}`);
    if (request.method === "GET" && urlObject.pathname === "/api/state") {
      await handleState(request, response, urlObject);
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

    if (request.method === "POST" && urlObject.pathname === "/api/start") {
      await handleStart(request, response);
      return;
    }

    if (request.method === "POST" && urlObject.pathname === "/api/respawn") {
      await handleRespawn(request, response);
      return;
    }

    if (request.method === "POST" && urlObject.pathname === "/api/add-bot") {
      await handleAddBot(request, response);
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
    if (room.players.size === 0 && room.mode !== "br") {
      rooms.delete(room.code);
    }
  }
}, CONFIG.tickMs);

server.listen(CONFIG.port, () => {
  console.log(`Move and Shoot server listening on http://localhost:${CONFIG.port}`);
});
