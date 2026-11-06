// physics.js
// Matter.js (グローバルの `Matter` を利用。index.html でCDN読み込み済み)
import { BALL_RADIUS_PX } from './board.js';

const { Engine, World, Bodies, Body, Composite } = Matter;

const BALL_FRICTION_AIR = 0.028; // ゴム弾き後、自然に減速して止まる
const BALL_RESTITUTION = 0.55;
const WALL_RESTITUTION = 0.7;

// 引っ張り距離→初速への変換。物理的なゴムの手応えを再現するための調整値。
export const MAX_PULL_DISTANCE = 90;
export const LAUNCH_POWER_SCALE = 0.11;

export function createWorld() {
  const engine = Engine.create();
  engine.gravity.y = 0;
  engine.gravity.x = 0;
  return engine;
}

export function buildBoardBodies(engine, config) {
  const bodies = [];
  const makeWall = (seg) => {
    const body = Bodies.rectangle(seg.x, seg.y, seg.w, seg.h, {
      isStatic: true,
      angle: seg.angle,
      restitution: WALL_RESTITUTION,
      friction: 0,
      label: 'wall',
    });
    body.isInner = !!seg.inner;   // 中心側の仕切り（試合の途中で消す）
    bodies.push(body);
    return body;
  };
  config.outerWalls.forEach(makeWall);
  config.dividerWalls.forEach(makeWall);
  Composite.add(engine.world, bodies);
  return bodies;
}

// ballDefs: [{id, zone, x, y}, ...] — ホストとゲストが同じ手順で独立生成し、
// 同じ配列になることを前提にした決定的なボール一覧(ネットワーク越しに共有する)。
export function buildBallDefs(config, zoneCount) {
  const defs = [];
  for (let zone = 0; zone < zoneCount; zone++) {
    const positions = config.ballStartPositions(zone);
    positions.forEach((pos, i) => {
      defs.push({ id: `b${zone}_${i}`, zone, x: pos.x, y: pos.y });
    });
  }
  return defs;
}

export function spawnBalls(engine, ballDefs) {
  const balls = ballDefs.map((def) => {
    const body = Bodies.circle(def.x, def.y, BALL_RADIUS_PX, {
      restitution: BALL_RESTITUTION,
      friction: 0.01,
      frictionAir: BALL_FRICTION_AIR,
      density: 0.002,
      label: 'ball',
    });
    body.gameId = def.id;
    body.originZone = def.zone;
    return body;
  });
  Composite.add(engine.world, balls);
  return balls;
}

// 「引っ張って離す」操作をスリングショットの初速に変換して打ち出す。
// pull = (アンカー位置 - 離した位置)。引っ張った向きと逆方向に飛ぶ。
export function launchBall(body, pull) {
  if (!pull || !Number.isFinite(pull.x) || !Number.isFinite(pull.y)) return false;   // おかしな値は使わない
  const rawDist = Math.hypot(pull.x, pull.y);
  if (rawDist < 6) return false; // 引っ張りが小さすぎる場合は不発
  const dist = Math.min(rawDist, MAX_PULL_DISTANCE);
  const ux = pull.x / rawDist;
  const uy = pull.y / rawDist;
  const speed = dist * LAUNCH_POWER_SCALE;
  Body.setVelocity(body, { x: ux * speed, y: uy * speed });
  return true;
}

// 中心側の仕切りを消す（真ん中を開ける）
export function removeInnerWalls(engine) {
  const inner = Composite.allBodies(engine.world).filter((b) => b.isInner);
  Composite.remove(engine.world, inner);
  return inner.length;
}

export function stepWorld(engine, deltaMs) {
  Engine.update(engine, deltaMs);
}

export function isSettled(body) {
  return Body.getSpeed(body) < 0.05;
}
