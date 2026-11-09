// cpu.js
// CPU（コンピューター）の考え方（2026-11-09 に追加）。
// CPU は人と同じ「玉を引っ張って離す」入力（ballId と pull）を作るだけ。発射はホストの _handleInput を通るので、
// 自分の陣地の玉しか打てない・0.4 秒あける、などのきまりは人と同じ。動かすのはホストだけ（オンラインでもホストの中で考える）。
//
// 考え方: 自分の陣地の玉それぞれについて、相手の陣地の中の点をいくつか選び、
//  - まっすぐ飛ばして壁に当たらないか（仕切りのすき間を通れるか）
//  - 止まる場所が相手の陣地の中か、どれくらい奥か
//  - とちゅうに玉があってじゃまされないか
// を点数にして、いちばん良い（よわいほど雑に選ぶ）1 発を撃つ。強さで「ねらいのずれ」「力のずれ」「考える間」「選び方」を変える。
import { BALL_RADIUS_PX } from './board.js';
import { MAX_PULL_DISTANCE, LAUNCH_POWER_SCALE, TRAVEL_PER_SPEED } from './physics.js';

export const CPU_LEVELS = {
  // 2026-11-09: 早送りの試合で調整（ねらった玉が相手の陣地に入る割合: よわい 約4〜5割 / ふつう 9割くらい / つよい ほぼ全部。撃つ間隔もちがう）
  // aim: 向きのずれ（ラジアン）/ pow: 力のずれ（割合）/ think: 次に撃つまでの間（ミリ秒）/ pick: 上位いくつから選ぶか / smart: 1 位の人をねらう・じゃまな玉を気にする
  weak:   { label: 'よわい', aim: 0.2,   pow: 0.25, think: [2400, 3600], pick: 99, smart: false, miss: 0.3 },
  normal: { label: 'ふつう', aim: 0.13,  pow: 0.12, think: [1700, 2500], pick: 4,  smart: true,  miss: 0.05 },
  strong: { label: 'つよい', aim: 0.04,  pow: 0.05, think: [950, 1300],  pick: 1,  smart: true,  miss: 0 },
};

const MAX_TRAVEL = MAX_PULL_DISTANCE * LAUNCH_POWER_SCALE * TRAVEL_PER_SPEED;   // いちばん強く撃ったときに転がる長さ（約 344）
const gauss = () => { let u = 0, v = 0; while (!u) u = Math.random(); while (!v) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };

// 壁を「太さのある線分」にしておく
function wallSegments(config, innerOpen) {
  return [...config.outerWalls, ...config.dividerWalls.filter((w) => !(w.inner && innerOpen))].map((w) => {
    // 長い方の辺を線分にする（2人用の左右の壁は w が太さ・h が長さ）
    const long = w.w >= w.h, a = w.angle + (long ? 0 : Math.PI / 2), len = long ? w.w : w.h;
    const c = Math.cos(a), s = Math.sin(a);
    return { ax: w.x - c * len / 2, ay: w.y - s * len / 2, bx: w.x + c * len / 2, by: w.y + s * len / 2, half: (long ? w.h : w.w) / 2 };
  });
}
function distToSeg(px, py, s) {
  const dx = s.bx - s.ax, dy = s.by - s.ay, l2 = dx * dx + dy * dy;
  let t = l2 ? ((px - s.ax) * dx + (py - s.ay) * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (s.ax + dx * t), py - (s.ay + dy * t));
}

// 玉 P から S までまっすぐ転がるとき、壁にぶつからないか（最初から壁にくっついている玉は、離れる向きならよい）
function pathClear(P, S, walls) {
  const len = Math.hypot(S.x - P.x, S.y - P.y), n = Math.max(1, Math.ceil(len / 5));
  for (const w of walls) {
    const lim = BALL_RADIUS_PX + w.half - 0.5, d0 = distToSeg(P.x, P.y, w);
    for (let i = 1; i <= n; i++) {
      const t = i / n, d = distToSeg(P.x + (S.x - P.x) * t, P.y + (S.y - P.y) * t, w);
      if (d < lim && d < d0 - 0.5) return false;
    }
  }
  return true;
}

// 相手の陣地の中の、ねらう点の候補
function targetPoints(config, zone) {
  const pts = [];
  if (config.kind === 'rect') {
    const sign = zone === 0 ? -1 : 1;
    for (const x of [-90, -45, 0, 45, 90]) for (const y of [55, 100, 145, 185]) pts.push({ x, y: sign * y });
  } else {
    const wedge = (Math.PI * 2) / config.playerCount, ca = wedge * zone - Math.PI / 2;
    for (const f of [-0.32, -0.16, 0, 0.16, 0.32]) for (const r of [75, 115, 155, 190]) pts.push({ x: Math.cos(ca + f * wedge) * r, y: Math.sin(ca + f * wedge) * r });
  }
  return pts;
}

// 陣地の境目からどれくらい奥か（奥ほど押し戻されにくい）
function depthIn(config, zone, p) {
  if (config.kind === 'rect') return Math.abs(p.y);
  const wedge = (Math.PI * 2) / config.playerCount, ca = wedge * zone - Math.PI / 2;
  let da = Math.atan2(p.y, p.x) - ca;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  return Math.hypot(p.x, p.y) * Math.sin(Math.max(0, wedge / 2 - Math.abs(da)));
}

// 1 発ぶんを考える。ctx: { config, innerOpen, balls: [{id,x,y,speed}], myZone, enemyZones, counts, level }
// 返り値: { ballId, pull } か null（撃てる玉がない）
export function cpuDecide(ctx) {
  const L = CPU_LEVELS[ctx.level] || CPU_LEVELS.normal;
  const { config } = ctx;
  const mine = ctx.balls.filter((b) => config.zoneOfPoint(b.x, b.y) === ctx.myZone);
  if (!mine.length || !ctx.enemyZones.length) return null;
  const walls = wallSegments(config, ctx.innerOpen);
  // 時間切れのときに少ない人が勝ちなので、いま玉がいちばん少ない相手（1 位）へ送るとよい
  const minEnemy = Math.min(...ctx.enemyZones.map((z) => ctx.counts[z] ?? 6));

  const cands = [];
  for (const b of mine) {
    for (const z of ctx.enemyZones) {
      for (const T of targetPoints(config, z)) {
        const dx = T.x - b.x, dy = T.y - b.y, D = Math.hypot(dx, dy);
        if (D < 30) continue;
        const ux = dx / D, uy = dy / D, travel = Math.min(D, MAX_TRAVEL);
        const S = { x: b.x + ux * travel, y: b.y + uy * travel };
        const sz = config.zoneOfPoint(S.x, S.y);
        if (sz === ctx.myZone || !ctx.enemyZones.includes(sz)) continue;   // 止まる場所が相手の陣地でない
        if (!pathClear(b, S, walls)) continue;
        let score = 10 + Math.min(depthIn(config, sz, S), 90) / 9;
        // とちゅうにある玉（ぶつかると止まったり向きが変わったりする）
        let block = 0;
        for (const o of ctx.balls) {
          if (o.id === b.id) continue;
          const t = ((o.x - b.x) * ux + (o.y - b.y) * uy);
          if (t < 0 || t > travel + BALL_RADIUS_PX) continue;
          const off = Math.abs((o.x - b.x) * uy - (o.y - b.y) * ux);
          if (off < BALL_RADIUS_PX * 2) block += t < travel * 0.6 ? 1 : 0.4;
        }
        if (L.smart) {
          score -= block * 4;
          if ((ctx.counts[sz] ?? 6) === minEnemy) score += 3;   // 1 位の人の陣地へ
          if (D > MAX_TRAVEL) score -= 2;                         // 届かない点は少し下げる
          score -= Math.min(b.speed || 0, 6) * 0.5;               // 動いている玉はずれやすい
        } else score -= block * 1.5;
        cands.push({ b, ux, uy, travel, score });
      }
    }
  }

  let pick;
  if (cands.length && Math.random() >= L.miss) {
    cands.sort((a, c) => c.score - a.score);
    pick = cands[Math.floor(Math.random() * Math.min(L.pick, cands.length))];
  } else {
    // よい道が見つからない（またはよわい CPU の雑な 1 発）: すき間の方へ強めに
    const b = mine[Math.floor(Math.random() * mine.length)];
    const z = ctx.enemyZones[Math.floor(Math.random() * ctx.enemyZones.length)];
    const T = config.kind === 'rect' ? { x: 0, y: z === 0 ? -100 : 100 } : (() => {
      const wedge = (Math.PI * 2) / config.playerCount, ea = wedge * ctx.myZone - Math.PI / 2 + (z === (ctx.myZone + 1) % config.playerCount ? 1 : -1) * wedge / 2;
      return { x: Math.cos(ea) * 100, y: Math.sin(ea) * 100 };
    })();
    const D = Math.hypot(T.x - b.x, T.y - b.y) || 1;
    pick = { b, ux: (T.x - b.x) / D, uy: (T.y - b.y) / D, travel: MAX_TRAVEL * (0.75 + Math.random() * 0.25) };
  }

  // ねらいと力に、強さに合わせたずれを入れる
  const ang = Math.atan2(pick.uy, pick.ux) + gauss() * L.aim;
  const travel = Math.max(40, Math.min(MAX_TRAVEL, pick.travel * (1 + gauss() * L.pow)));
  const len = Math.max(8, Math.min(MAX_PULL_DISTANCE, travel / TRAVEL_PER_SPEED / LAUNCH_POWER_SCALE));
  return { ballId: pick.b.id, pull: { x: Math.cos(ang) * len, y: Math.sin(ang) * len } };
}

export const cpuThinkMs = (level) => { const t = (CPU_LEVELS[level] || CPU_LEVELS.normal).think; return t[0] + Math.random() * (t[1] - t[0]); };
