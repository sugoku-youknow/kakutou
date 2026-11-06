// board.js
// ボードの形状・陣地(ゾーン)・初期ボール配置を、参加人数(2/3/4)ごとに定義する。
// すべて中心(0,0)を原点とするローカル座標系。canvas側で好きな位置に平行移動して描画する。

export const ZONE_COLORS = ['#e2793d', '#3f7fd1', '#4caf7d', '#a869d6'];

const BALL_RADIUS = 18;
const WALL_THICKNESS = 8;

// ---- 2人用: 縦長の長方形を上下2分割 ----------------------------------
function buildRectBoard() {
  const width = 260;
  const height = 460;
  const gapHalfWidth = 40; // 中央の通行可能な隙間の半幅（2026-11-06 に 27 → 40。玉 2 個ぶん。止まった玉で詰まらないように）

  const outerWalls = [
    // 上辺
    { x: 0, y: -height / 2, w: width + WALL_THICKNESS * 2, h: WALL_THICKNESS, angle: 0 },
    // 下辺
    { x: 0, y: height / 2, w: width + WALL_THICKNESS * 2, h: WALL_THICKNESS, angle: 0 },
    // 左辺
    { x: -width / 2, y: 0, w: WALL_THICKNESS, h: height + WALL_THICKNESS * 2, angle: 0 },
    // 右辺
    { x: width / 2, y: 0, w: WALL_THICKNESS, h: height + WALL_THICKNESS * 2, angle: 0 },
  ];

  // 中央の仕切り: 左右2本の壁を置き、中心にだけ隙間を残す
  const dividerWalls = [
    {
      x: -(width / 4 + gapHalfWidth / 2),
      y: 0,
      w: width / 2 - gapHalfWidth,
      h: WALL_THICKNESS,
      angle: 0,
    },
    {
      x: width / 4 + gapHalfWidth / 2,
      y: 0,
      w: width / 2 - gapHalfWidth,
      h: WALL_THICKNESS,
      angle: 0,
    },
  ];

  const zoneOfPoint = (x, y) => (y < 0 ? 0 : 1);

  const ballStartPositions = (zoneIndex) => {
    const rowY = zoneIndex === 0 ? -height / 2 + 46 : height / 2 - 46;
    const positions = [];
    const count = 6;
    const spacing = (width - 60) / (count - 1);
    for (let i = 0; i < count; i++) {
      positions.push({ x: -width / 2 + 30 + spacing * i, y: rowY });
    }
    return positions;
  };

  const launcherAnchor = (zoneIndex) => ({
    x: 0,
    y: zoneIndex === 0 ? -height / 2 + 90 : height / 2 - 90,
  });

  const zonePolygon = (zoneIndex) => {
    const y1 = zoneIndex === 0 ? -height / 2 : 0;
    const y2 = zoneIndex === 0 ? 0 : height / 2;
    return [
      { x: -width / 2, y: y1 },
      { x: width / 2, y: y1 },
      { x: width / 2, y: y2 },
      { x: -width / 2, y: y2 },
    ];
  };

  return {
    playerCount: 2,
    kind: 'rect',
    bounds: { width: width + 40, height: height + 40 },
    outerWalls,
    dividerWalls,
    zoneOfPoint,
    zonePolygon,
    ballStartPositions,
    launcherAnchor,
    zoneLabelPos: (zoneIndex) => ({ x: -width / 2 + 14, y: zoneIndex === 0 ? -height / 2 + 16 : height / 2 - 16 }),
  };
}

// ---- 3人用(六角形)/ 4人用(八角形): 中心から放射状に扇形分割 ------------
function buildPolygonBoard(playerCount) {
  const sides = playerCount === 3 ? 6 : 8; // 3人=六角形、4人=八角形
  const outerRadius = 230;
  const gapRadius = 40; // この半径より内側は壁が無く自由に通行できる

  // 外周の壁(多角形の各辺を短い壁セグメントで近似)
  const outerWalls = [];
  for (let i = 0; i < sides; i++) {
    const a1 = (Math.PI * 2 * i) / sides - Math.PI / 2;
    const a2 = (Math.PI * 2 * (i + 1)) / sides - Math.PI / 2;
    const x1 = Math.cos(a1) * outerRadius;
    const y1 = Math.sin(a1) * outerRadius;
    const x2 = Math.cos(a2) * outerRadius;
    const y2 = Math.sin(a2) * outerRadius;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const len = Math.hypot(x2 - x1, y2 - y1);
    const angle = Math.atan2(y2 - y1, x2 - x1);
    outerWalls.push({ x: mx, y: my, w: len + WALL_THICKNESS, h: WALL_THICKNESS, angle });
  }

  // 放射状の仕切り(プレイヤー数と同じ本数)、中心はgapRadiusまで空ける
  const wedgeAngle = (Math.PI * 2) / playerCount;
  const dividerWalls = [];

  // 仕切りの穴の位置
  // 中心から holeStart ～ holeEnd の間を空ける
  // 2026-11-06: 穴を広げた（70〜124 → 55〜140。玉 2 個ぶん以上）。中心側の壁（inner）は、試合の半分が過ぎると消えて真ん中が開く
  const holeStart = 55;
  const holeEnd = 140;

  for (let i = 0; i < playerCount; i++) {
    const angle =
      wedgeAngle * i - Math.PI / 2 - wedgeAngle / 2;

    // 中心側の壁
    const innerLen = holeStart;

    if (innerLen > 0) {
      const innerMidR = innerLen / 2;

      dividerWalls.push({
        x: Math.cos(angle) * innerMidR,
        y: Math.sin(angle) * innerMidR,
        w: innerLen,
        h: WALL_THICKNESS,
        angle: angle,
        inner: true,
      });
    }

    // 外側の壁
    const outerLen = outerRadius - holeEnd;

    if (outerLen > 0) {
      const outerMidR = (holeEnd + outerRadius) / 2;

      dividerWalls.push({
        x: Math.cos(angle) * outerMidR,
        y: Math.sin(angle) * outerMidR,
        w: outerLen,
        h: WALL_THICKNESS,
        angle: angle,
      });
    }
  }
  const zoneOfPoint = (x, y) => {
    let a = Math.atan2(y, x) + Math.PI / 2 + wedgeAngle / 2;
    a = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return Math.floor(a / wedgeAngle) % playerCount;
  };

  const ballStartPositions = (zoneIndex) => {
    const centerAngle = wedgeAngle * zoneIndex - Math.PI / 2;
    const positions = [];
    const count = 6;
    const rStart = gapRadius + 30;
    const rEnd = outerRadius - 30;
    const spread = wedgeAngle * 0.32;
    for (let i = 0; i < count; i++) {
      const t = i / (count - 1);
      const r = rStart + (rEnd - rStart) * t;
      const a = centerAngle - spread / 2 + spread * (i % 2);
      positions.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return positions;
  };

  const launcherAnchor = (zoneIndex) => {
    const centerAngle = wedgeAngle * zoneIndex - Math.PI / 2;
    const r = outerRadius - 45;
    return { x: Math.cos(centerAngle) * r, y: Math.sin(centerAngle) * r };
  };

  const zonePolygon = (zoneIndex) => {
    const a0 = wedgeAngle * zoneIndex - Math.PI / 2 - wedgeAngle / 2;
    const a1 = a0 + wedgeAngle;
    const steps = 8;
    const points = [{ x: 0, y: 0 }];
    for (let i = 0; i <= steps; i++) {
      const a = a0 + ((a1 - a0) * i) / steps;
      points.push({ x: Math.cos(a) * outerRadius, y: Math.sin(a) * outerRadius });
    }
    return points;
  };

  return {
    playerCount,
    kind: 'polygon',
    bounds: { width: outerRadius * 2 + 40, height: outerRadius * 2 + 40 },
    outerWalls,
    dividerWalls,
    zoneOfPoint,
    zonePolygon,
    ballStartPositions,
    launcherAnchor,
    zoneLabelPos: (zoneIndex) => {
      const centerAngle = wedgeAngle * zoneIndex - Math.PI / 2;
      const r = outerRadius + 18;
      return { x: Math.cos(centerAngle) * r, y: Math.sin(centerAngle) * r };
    },
  };
}

export function getBoardConfig(playerCount) {
  if (playerCount === 2) return buildRectBoard();
  if (playerCount === 3) return buildPolygonBoard(3);
  if (playerCount === 4) return buildPolygonBoard(4);
  throw new Error(`unsupported player count: ${playerCount}`);
}

export const BALL_RADIUS_PX = BALL_RADIUS;
