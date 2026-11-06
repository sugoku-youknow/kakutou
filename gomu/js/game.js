// game.js
// ロビー→待機→対戦→終了、というゲーム全体の流れと、
// ホスト権威型のネットワーク同期(誰か1人が物理演算の「正」を持ち、他人には結果だけ配る)を管理する。
//
// 2026-11-06 の変更（you know games に入れるとき）
// - 制限時間をつけた（2人 90 秒 / 3〜4人 120 秒）。時間切れのときは、陣地の玉がいちばん少ない人の勝ち。
//   同じ数の人が複数いたら、最大 20 秒のサドンデス（その人たちのうち、ほかより少なくなった 1 人の勝ち）。それでも決まらなければ、その人たち全員の勝ち（引き分け）。
// - 試合の半分が過ぎると、3〜4人の盤面の真ん中の仕切りが消えて、玉が通りやすくなる（決着をつきやすくする）。
// - 1 人が続けて撃てる間隔を 0.4 秒にした（連打の速さだけで決まらないように）。
// - 物理は 1/60 秒ずつの固定の刻みで進める（画面の速さ 60 / 120Hz で玉の速さが変わらないように）。setInterval で回す。
// - 玉の位置は 0.1 単位に丸めて、30 回/秒で送る（落としてよい通り道）。全部止まっているときは 1 秒に 1 回だけ。
// - 途中で抜けた人がいて、遊ぶ人が 1 人になったら、その人の勝ちで終わる。
import { getBoardConfig } from './board.js';
import { createWorld, buildBoardBodies, buildBallDefs, spawnBalls, launchBall, stepWorld, removeInnerWalls } from './physics.js';
import { ZONE_COLORS } from './board.js';

const STATE_INTERVAL_MS = 33;      // 玉の位置を送る間隔（約 30 回/秒）
const IDLE_INTERVAL_MS = 1000;     // 全部止まっているとき
const STEP_MS = 1000 / 60;
const SHOT_COOLDOWN_MS = 400;      // 1 人が続けて撃てる間隔
const SUDDEN_MS = 20000;           // 時間切れで同点だったときのサドンデスの長さ
export const timeLimitMs = (n) => (n === 2 ? 90000 : 120000);

export class Game {
  constructor(network) {
    this.network = network;
    this.phase = 'lobby'; // lobby | waiting | countdown | playing | ended
    this.config = null;
    this.zoneAssignment = null; // Map peerId -> zoneIndex
    this.myZone = null;         // 観戦の人は undefined
    this.playerNames = new Map();
    this.ballDefs = null;
    this.winnerZones = [];      // 勝った陣地（同点のときは複数）
    this.finalCounts = null;
    this.timeLeftMs = 0;
    this.sudden = false;
    this.innerOpen = false;
    this.counts = [];

    // ホスト側のみ使う実体
    this.engine = null;
    this.bodiesById = null;
    this._timer = null;
    this.lastStart = null;      // 途中から来た観戦の人に送る

    // ゲスト側の描画用(補間して滑らかに見せる)
    this.renderPositions = new Map(); // id -> {x,y} 表示用(平滑化済み)
    this.targetPositions = new Map(); // id -> {x,y} 直近に受信した値
    this._lastRender = performance.now();

    this.onPhaseChange = () => {};
    this.onCounts = () => {};
    this.onResult = () => {};   // ホスト: 勝ち負けが決まった（名前の一覧で）

    this._wireNetwork();
  }

  get isSpectator() { return this.phase !== 'lobby' && this.zoneAssignment && this.myZone === undefined; }

  _wireNetwork() {
    const net = this.network;
    net.on('start', (payload) => this._handleStart(payload));
    net.on('state', (payload) => this._handleState(payload));
    net.on('open', () => { this.innerOpen = true; });
    net.on('end', (payload) => this._handleEnd(payload));
    net.on('input', (payload, { peerId }) => this._handleInput(payload, peerId));
  }

  // ---- ホスト操作: ルーム内の人数からゲームを開始する ----------------
  startAsHost() {
    if (!this.network.isHost) throw new Error('not host');
    const guestIds = Array.from(this.network.peers).filter((id) => !this.network.spectators.has(id));
    const playerIds = [this.network.selfId, ...guestIds].slice(0, 4);
    const n = playerIds.length;
    if (n < 2) throw new Error('need at least 2 players');

    const config = getBoardConfig(n);
    const ballDefs = buildBallDefs(config, n);

    const payload = {
      playerCount: n,
      zoneAssignment: playerIds, // index = zoneIndex, value = peerId
      ballDefs,
      playerNames: playerIds.map((id) => ({ playerId: id, playerName: this.network.playerNames.get(id) || id })),
    };
    this.lastStart = payload;
    this.network.send('start', payload);
    this._handleStart(payload); // 自分自身にも同じ手順を適用する
  }

  // 途中から来た観戦の人へ: 始まりの情報と今の位置
  sendCurrentTo(peerId) {
    if (!this.lastStart || this.phase === 'ended' || this.phase === 'lobby') return;
    this.network.send('start', { ...this.lastStart, late: true }, peerId);
    if (this.innerOpen) this.network.send('open', {}, peerId);
  }

  _handleStart({ playerCount, zoneAssignment, ballDefs, playerNames, late }) {
    this.config = getBoardConfig(playerCount);
    this.ballDefs = ballDefs;
    this.zoneAssignment = new Map(zoneAssignment.map((peerId, zone) => [peerId, zone]));
    this.myZone = this.zoneAssignment.get(this.network.selfId);
    this.phase = late ? 'playing' : 'countdown';
    this.winnerZones = [];
    this.finalCounts = null;
    this.sudden = false;
    this.innerOpen = false;
    this.timeLeftMs = timeLimitMs(playerCount);
    this.renderPositions.clear();
    this.targetPositions.clear();
    this.playerNames.clear();
    this.counts = new Array(playerCount).fill(6);
    playerNames.forEach(({ playerId, playerName }) => this.playerNames.set(playerId, playerName));
    ballDefs.forEach((def) => {
      this.renderPositions.set(def.id, { x: def.x, y: def.y });
      this.targetPositions.set(def.id, { x: def.x, y: def.y });
    });

    if (late) { this.onPhaseChange('playing'); return; }
    this.onPhaseChange('countdown');

    setTimeout(() => {
      if (this.phase !== 'countdown') return;
      this.phase = 'playing';
      if (this.network.isHost) {
        this.engine = createWorld();
        buildBoardBodies(this.engine, this.config);
        const bodies = spawnBalls(this.engine, ballDefs);
        this.bodiesById = new Map(bodies.map((b) => [b.gameId, b]));
        this._lastShot = new Map();
        this._startHostLoop();
      }
      this.onPhaseChange('playing');
    }, 3000);
  }

  // ホストの計算: 固定の刻みで物理を進め、決着を判定し、位置を配る
  _startHostLoop() {
    const limit = timeLimitMs(this.config.playerCount);
    const startedAt = performance.now();
    let last = startedAt, acc = 0, lastSend = 0, suddenAt = 0;
    clearInterval(this._timer);
    this._timer = setInterval(() => {
      if (this.phase !== 'playing') { clearInterval(this._timer); return; }
      const now = performance.now();
      acc += Math.min(now - last, 250); last = now;
      let steps = 0;
      while (acc >= STEP_MS && steps < 15) { stepWorld(this.engine, STEP_MS); acc -= STEP_MS; steps++; }
      if (steps >= 15) acc = 0;

      const elapsed = now - startedAt;
      // 半分を過ぎたら真ん中を開ける（3〜4人）
      if (!this.innerOpen && elapsed > limit / 2 && this.config.playerCount > 2) {
        removeInnerWalls(this.engine);
        this.innerOpen = true;
        this.network.send('open', {});
      }

      const counts = new Array(this.config.playerCount).fill(0);
      const ballStates = [];
      let moving = false;
      for (const body of this.bodiesById.values()) {
        const zone = this.config.zoneOfPoint(body.position.x, body.position.y);
        counts[zone] += 1;
        const x = Math.round(body.position.x * 10) / 10, y = Math.round(body.position.y * 10) / 10;
        ballStates.push([body.gameId, x, y]);
        if (body.speed > 0.05) moving = true;
        this.targetPositions.set(body.gameId, { x: body.position.x, y: body.position.y });
      }
      this.counts = counts;
      this.timeLeftMs = Math.max(0, limit - elapsed);
      this.onCounts(counts);

      // 決着: 陣地の玉が 0 になった人の勝ち
      const empty = counts.flatMap((c, z) => (c === 0 ? [z] : []));
      if (empty.length) { this._declareWinners(empty, counts); return; }
      // 時間切れ: いちばん少ない人の勝ち。同点ならサドンデス
      if (elapsed >= limit) {
        const min = Math.min(...counts);
        const leaders = counts.flatMap((c, z) => (c === min ? [z] : []));
        if (leaders.length === 1) { this._declareWinners(leaders, counts); return; }
        if (!this.sudden) { this.sudden = true; suddenAt = now; }
        else if (now - suddenAt >= SUDDEN_MS) { this._declareWinners(leaders, counts); return; }
      }

      if (now - lastSend >= (moving ? STATE_INTERVAL_MS : IDLE_INTERVAL_MS)) {
        lastSend = now;
        this.network.send('state', { b: ballStates, c: counts, t: Math.ceil(this.timeLeftMs / 1000), s: this.sudden ? 1 : 0 });
      }
    }, STEP_MS);
  }

  _declareWinners(zones, counts) {
    const payload = { winnerZones: zones, counts };
    this.network.send('end', payload);
    this._handleEnd(payload);
    // 成績（ホストだけ）: 勝った陣地の人と、それ以外の人
    const nameOfZone = (z) => this.playerNames.get([...this.zoneAssignment.entries()].find(([, zone]) => zone === z)?.[0]);
    const all = [...this.zoneAssignment.values()];
    if (all.every((z) => zones.includes(z))) return;   // 全員同点の引き分けは成績に数えない
    this.onResult(zones.map(nameOfZone).filter(Boolean), all.filter((z) => !zones.includes(z)).map(nameOfZone).filter(Boolean));
  }

  _handleEnd({ winnerZones, counts }) {
    this.phase = 'ended';
    this.winnerZones = winnerZones || [];
    this.finalCounts = counts || this.counts;
    clearInterval(this._timer);
    this.onPhaseChange('ended');
  }

  _handleState({ b, c, t, s }) {
    if (this.network.isHost) return; // ホストは自分のシミュレーションが正なので無視
    b.forEach(([id, x, y]) => this.targetPositions.set(id, { x, y }));
    this.counts = c;
    this.timeLeftMs = t * 1000;
    this.sudden = !!s;
    this.onCounts(c);
  }

  // 途中で抜けた人: 遊ぶ人が 1 人になったら、その人の勝ち
  playerLeft(peerId) {
    if (!this.network.isHost || this.phase !== 'playing' || !this.zoneAssignment.has(peerId)) return;
    this._gone = this._gone || new Set();
    this._gone.add(peerId);
    const left = [...this.zoneAssignment.entries()].filter(([id]) => !this._gone.has(id));
    if (left.length === 1) this._declareWinners([left[0][1]], this.counts);
  }

  // ゲストからの発射リクエストをホストが検証して適用する
  _handleInput({ ballId, pull }, peerId) {
    if (!this.network.isHost || this.phase !== 'playing' || !this.bodiesById) return;
    const requesterZone = this.zoneAssignment.get(peerId);
    const body = this.bodiesById.get(ballId);
    if (body == null || requesterZone == null) return;
    const currentZone = this.config.zoneOfPoint(body.position.x, body.position.y);
    if (currentZone !== requesterZone) return; // 自分の陣地にある玉しか打てない
    const now = performance.now();
    if (now - (this._lastShot.get(peerId) || 0) < SHOT_COOLDOWN_MS) return;   // 続けて撃つのは 0.4 秒あける
    if (launchBall(body, pull)) this._lastShot.set(peerId, now);
  }

  // ---- 入力(誰でも呼ぶ: ホストなら直接、ゲスト側ならネットワーク送信) ----
  requestLaunch(ballId, pull) {
    if (this.isSpectator) return;
    if (this.network.isHost) this._handleInput({ ballId, pull }, this.network.selfId);
    else this.network.send('input', { ballId, pull });
  }

  // 毎フレーム呼び出す: ゲスト側の表示位置をなめらかに追従させる（画面の速さに関係なく同じ速さで近づける）
  smoothRenderPositions() {
    const now = performance.now();
    const k = 1 - Math.exp(-(now - this._lastRender) / 45);
    this._lastRender = now;
    for (const [id, target] of this.targetPositions) {
      const cur = this.renderPositions.get(id) || target;
      const far = Math.hypot(target.x - cur.x, target.y - cur.y) > 120;   // 大きくずれたらすぐ合わせる
      this.renderPositions.set(id, far ? { ...target } : { x: cur.x + (target.x - cur.x) * k, y: cur.y + (target.y - cur.y) * k });
    }
  }

  getMyZoneBallIds() {
    if (!this.config || this.myZone === undefined) return [];
    return this.getRenderBalls().filter((b) => this.config.zoneOfPoint(b.x, b.y) === this.myZone).map((b) => b.id);
  }

  getRenderBalls() {
    if (!this.ballDefs) return [];
    if (this.network.isHost && this.bodiesById) {
      return this.ballDefs.map((def) => {
        const body = this.bodiesById.get(def.id);
        return { id: def.id, x: body.position.x, y: body.position.y, color: this.ballColor(def) };
      });
    }
    return this.ballDefs.map((def) => {
      const pos = this.renderPositions.get(def.id) || { x: def.x, y: def.y };
      return { id: def.id, x: pos.x, y: pos.y, color: this.ballColor(def) };
    });
  }

  ballColor(def) { return ZONE_COLORS[def.zone % ZONE_COLORS.length]; }
}
