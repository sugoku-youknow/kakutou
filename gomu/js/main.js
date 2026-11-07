import { Network } from './network.js';
import { Game } from './game.js';
import { ZONE_COLORS, BALL_RADIUS_PX } from './board.js';

// パーティ（you know games のゲーム一覧で作るグループ）から開いたとき（?party=1）は、番号を入れずに自動で部屋を作る・入る
const PARTY = (() => {
  try { if (!new URLSearchParams(location.search).has('party')) return null; const j = JSON.parse(sessionStorage.getItem('ykg-party') || 'null'); return j && /^\d$/.test(j.code) ? j : null; } catch (e) { return null; }
})();
const toGames = () => { ykgToGames(); };
// パーティの成績: 勝ち負けが決まったら、ゲーム一覧で集計するために置いておく（ホストだけ）
function partyReport(w, l) {
  if (!PARTY || PARTY.role !== 'host') return;
  try { const a = JSON.parse(sessionStorage.getItem('ykg-results') || '[]'); a.push({ game: 'gomu', w, l }); sessionStorage.setItem('ykg-results', JSON.stringify(a)); } catch (e) {}
}

const network = new Network(PARTY);
const game = new Game(network);
const nameOf = (id, i) => network.playerNames.get(id) || game.playerNames.get(id) || `プレイヤー${(i ?? 0) + 1}`;

// ---- 画面切り替え ----------------------------------------------------
const screens = {
  lobby: document.getElementById('screen-lobby'),
  waiting: document.getElementById('screen-waiting'),
  game: document.getElementById('screen-game'),
  ended: document.getElementById('screen-ended'),
};
function showScreen(name) {
  Object.entries(screens).forEach(([key, el]) => el.classList.toggle('hidden', key !== name));
  document.body.dataset.screen = name;
  // パーティ: 待機画面のかわりに、全部のゲームで同じ構図の待ち合わせ画面（party-beacon.js の ykgLobby）を出す
  if (PARTY && window.ykgLobby) { if (name === 'waiting') partyLobby(); else ykgLobby.close(); }
}
let lobbyReady = false;   // パーティ: 部屋を作った・入った
const LOBBY_RULES = '自分の陣地の玉をゴムで弾いて相手の陣地へ送る。先に陣地の玉を0個にした人の勝ち。\n制限時間は2人90秒・3〜4人120秒。時間切れは玉がいちばん少ない人の勝ち（3〜4人は半分を過ぎると真ん中が開く）。';
function partyLobby() {
  if (!PARTY || !window.ykgLobby || document.body.dataset.screen !== 'waiting') return;
  const hostId = network.isHost ? network.selfId : network.prefix + network.roomCode;
  const ids = lobbyReady ? [hostId, ...[...network.peers].filter((id) => id !== hostId)] : [];
  if (lobbyReady && !network.isHost && !ids.includes(network.selfId)) ids.push(network.selfId);
  const players = ids.filter((id) => !network.spectators.has(id));
  const specs = ids.filter((id) => network.spectators.has(id));
  const members = lobbyReady ? [
    ...players.map((id, i) => ({ name: nameOf(id, i), tag: i === 0 ? 'ホスト' : i >= 4 ? '観戦' : '', me: id === network.selfId })),
    ...specs.map((id) => ({ name: nameOf(id), tag: '観戦', me: id === network.selfId })),
  ] : [{ name: playerName, tag: network.isHost || PARTY.role === 'host' ? 'ホスト' : '', me: true }];
  const n = Math.min(players.length, 4);
  const opts = { rules: LOBBY_RULES, members, settings: null };
  if (PARTY.role === 'host') {
    opts.button = { label: 'スタート', disabled: !lobbyReady || n < 2, onClick: () => { try { game.startAsHost(); } catch (e) { console.error(e); } } };
    opts.status = !lobbyReady ? '部屋を準備しています…' : n < 2 ? 'あと1人必要です（2〜4人）' : `${n}人で遊びます`;
  } else {
    opts.button = null;
    opts.wait = !lobbyReady ? 'ホストにつないでいます…' : PARTY.spec || network.spectators.has(network.selfId) ? '観戦: ホストがスタートするのを待っています…' : 'ホストがスタートするのを待っています…';
    opts.status = '';
  }
  ykgLobby.open(opts);
}

// ---- ロビー ----------------------------------------------------------
const lobbyError = document.getElementById('lobby-error');
const playerNameInput = document.getElementById('input-player-name');
try { playerNameInput.value = localStorage.getItem('gomu-name') || ''; } catch (e) {}
let playerName = '';

async function hostRoom(name, code) {
  const c = await network.createRoom(name, code);
  lobbyReady = true;
  document.getElementById('room-code-display').textContent = c;
  setupWaitingScreen(true);
  showScreen('waiting');
}
async function joinRoom(name, code) {
  await network.joinRoom(code, name);
  lobbyReady = true;
  document.getElementById('room-code-display').textContent = code;
  setupWaitingScreen(false);
  showScreen('waiting');
}

document.getElementById('btn-create-room').addEventListener('click', async () => {
  lobbyError.textContent = '';
  playerName = playerNameInput.value.trim();
  if (!playerName) { lobbyError.textContent = 'プレイヤー名を入力してください。'; return; }
  try { localStorage.setItem('gomu-name', playerName); } catch (e) {}
  try { await hostRoom(playerName); }
  catch (e) { console.error(e); lobbyError.textContent = '部屋の作成に失敗しました。通信環境を確認してもう一度お試しください。'; }
});

document.getElementById('btn-join-room').addEventListener('click', async () => {
  lobbyError.textContent = '';
  playerName = playerNameInput.value.trim();
  if (!playerName) { lobbyError.textContent = 'プレイヤー名を入力してください。'; return; }
  try { localStorage.setItem('gomu-name', playerName); } catch (e) {}
  const code = document.getElementById('input-room-code').value.trim();
  if (!/^[0-9]$/.test(code)) { lobbyError.textContent = '部屋コード（1けたの数字）を入力してください。'; return; }
  lobbyError.textContent = 'つないでいます…';
  try { await joinRoom(playerName, code); lobbyError.textContent = ''; }
  catch (e) { console.error(e); lobbyError.textContent = '部屋が見つかりません。部屋コードを確認してください。'; }
});

// ---- 待機画面 ----------------------------------------------------------
function renderPlayerList() {
  const list = document.getElementById('player-list');
  const ids = [network.isHost ? network.selfId : network.prefix + network.roomCode, ...[...network.peers].filter((id) => id !== network.prefix + network.roomCode)];
  if (!network.isHost && !ids.includes(network.selfId)) ids.push(network.selfId);
  const players = ids.filter((id) => !network.spectators.has(id));
  const specs = ids.filter((id) => network.spectators.has(id));
  document.getElementById('player-count').textContent = Math.min(players.length, 4);
  list.innerHTML = '';
  players.forEach((id, i) => {
    const li = document.createElement('li');
    li.textContent = nameOf(id, i) + (i === 0 ? ' (ホスト)' : '') + (i >= 4 ? '（5人目以降は観戦）' : '');
    if (id === network.selfId) li.classList.add('me');
    list.appendChild(li);
  });
  specs.forEach((id) => {
    const li = document.createElement('li');
    li.textContent = nameOf(id) + '（観戦）';
    li.classList.add('spec');
    if (id === network.selfId) li.classList.add('me');
    list.appendChild(li);
  });
  const startBtn = document.getElementById('btn-start-game');
  if (network.isHost) startBtn.disabled = players.length < 2;
  partyLobby();
}

function setupWaitingScreen(isHost) {
  document.getElementById('host-only-note').classList.toggle('hidden', !isHost);
  document.getElementById('btn-start-game').classList.toggle('hidden', !isHost);
  document.getElementById('guest-wait-note').classList.toggle('hidden', isHost);
  document.getElementById('room-code-card').classList.toggle('hidden', !!PARTY);
  renderPlayerList();
}
network.onPlayerName = renderPlayerList;
network.onPeerJoin = (id) => { renderPlayerList(); if (game.phase === 'playing' || game.phase === 'countdown') game.sendCurrentTo(id); };
network.onPeerLeave = (id) => { renderPlayerList(); game.playerLeft(id); };
network.onHostLost = () => {
  if (PARTY) { toGames(); return; }
  alert('ホストとの接続が切れました'); location.reload();
};
game.onResult = (w, l) => partyReport(w, l);

document.getElementById('btn-start-game').addEventListener('click', () => {
  try { game.startAsHost(); } catch (e) { console.error(e); }
});
const leave = () => { if (PARTY) { toGames(); return; } network.leave(); location.reload(); };
document.getElementById('btn-leave-waiting').addEventListener('click', leave);
document.getElementById('btn-leave-game').addEventListener('click', () => { if (confirm(PARTY ? 'ゲーム一覧へ戻りますか？' : '退出しますか？')) leave(); });
document.getElementById('btn-back-to-lobby').addEventListener('click', () => {
  if (PARTY && network.isHost) { setupWaitingScreen(true); showScreen('waiting'); game.phase = 'lobby'; return; }   // ホスト: もう一回（同じ部屋で）
  if (PARTY) { setupWaitingScreen(false); showScreen('waiting'); game.phase = 'lobby'; return; }
  location.reload();
});
document.getElementById('btn-games').addEventListener('click', toGames);
document.getElementById('btn-games-end').addEventListener('click', toGames);

// ---- ゲーム画面: キャンバス描画 ---------------------------------------
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
let dragState = null; // { ballId, originX, originY, pointerX, pointerY, pointerId }
let view = { k: 1, scale: 1, rotation: 0 };   // k: 盤面 1 単位 → キャンバスのピクセル（dpr 込み）/ scale: → 画面の CSS ピクセル / 盤面の回転

// 自分の陣地が手前（下）に来るように回す（観戦の人は回さない）
function getBoardRotation(config) {
  if (game.myZone === undefined || game.myZone === null) return 0;
  if (config.playerCount === 2) return game.myZone === 0 ? Math.PI : 0;
  const wedgeAngle = (Math.PI * 2) / config.playerCount;
  return Math.PI / 2 - (wedgeAngle * game.myZone - Math.PI / 2);
}

// キャンバスを、見えている大きさ × 画面の密度（dpr）で作る（引き伸ばさないのでくっきり）
function resizeCanvas() {
  const config = game.config; if (!config) return;
  const wrap = document.querySelector('.board-wrap');
  const availW = wrap.clientWidth || window.innerWidth, availH = wrap.clientHeight || window.innerHeight * 0.7;
  const scale = Math.min(availW / config.bounds.width, availH / config.bounds.height);
  const cssW = config.bounds.width * scale, cssH = config.bounds.height * scale;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  view = { k: scale * dpr, scale, rotation: getBoardRotation(config) };
}
let resizeT = 0;
window.addEventListener('resize', () => { clearTimeout(resizeT); resizeT = setTimeout(resizeCanvas, 80); });

function applyView() {
  const { k, rotation } = view, cos = Math.cos(rotation), sin = Math.sin(rotation);
  ctx.setTransform(k * cos, k * sin, -k * sin, k * cos, canvas.width / 2, canvas.height / 2);
}

function drawWallSegment(seg) {
  ctx.save();
  ctx.translate(seg.x, seg.y);
  ctx.rotate(seg.angle);
  ctx.fillStyle = '#4a4438';
  ctx.fillRect(-seg.w / 2, -seg.h / 2, seg.w, seg.h);
  ctx.restore();
}

function drawBoard() {
  const config = game.config;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  applyView();

  ctx.fillStyle = '#efe6cf';
  if (config.kind === 'rect') {
    ctx.fillRect(-config.bounds.width / 2 + 20, -config.bounds.height / 2 + 20, config.bounds.width - 40, config.bounds.height - 40);
  } else {
    ctx.beginPath();
    ctx.arc(0, 0, config.bounds.width / 2 - 20, 0, Math.PI * 2);
    ctx.fill();
  }

  // 陣地の色分け（自分の陣地は少し濃く）
  for (let z = 0; z < config.playerCount; z++) {
    const pts = config.zonePolygon(z);
    ctx.beginPath();
    pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = ZONE_COLORS[z % ZONE_COLORS.length];
    ctx.globalAlpha = z === game.myZone ? 0.3 : 0.14;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  config.outerWalls.forEach(drawWallSegment);
  config.dividerWalls.forEach((w) => { if (!(w.inner && game.innerOpen)) drawWallSegment(w); });   // 真ん中が開いたら中心側の仕切りは描かない

  // 各陣地にプレイヤー名
  ctx.save();
  ctx.fillStyle = 'rgba(34,34,34,.75)';
  ctx.font = 'bold 20px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let z = 0; z < config.playerCount; z++) {
    const playerId = [...game.zoneAssignment.entries()].find(([, zone]) => zone === z)?.[0];
    const name = game.playerNames.get(playerId) || `プレイヤー${z + 1}`;
    let x, y;
    if (config.kind === 'rect') { x = 0; y = (z === 0 ? -1 : 1) * config.bounds.height * 0.22; }
    else {
      const wedgeAngle = (Math.PI * 2) / config.playerCount, a = wedgeAngle * z - Math.PI / 2, d = config.bounds.width * 0.32;
      x = Math.cos(a) * d; y = Math.sin(a) * d;
    }
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-view.rotation);
    ctx.fillText(name, 0, 0);
    ctx.restore();
  }
  ctx.restore();
}

function drawBalls() {
  const mine = new Set(game.getMyZoneBallIds());
  game.getRenderBalls().forEach((b) => {
    ctx.beginPath();
    ctx.arc(b.x, b.y, BALL_RADIUS_PX, 0, Math.PI * 2);
    ctx.fillStyle = b.color;
    ctx.fill();
    ctx.lineWidth = mine.has(b.id) ? 3 : 2;
    ctx.strokeStyle = mine.has(b.id) ? 'rgba(255,255,255,0.9)' : 'rgba(0,0,0,0.35)';   // 今さわれる玉は白いふち
    ctx.stroke();
  });
}

function drawDragLine() {
  if (!dragState) return;
  const ball = game.getRenderBalls().find((b) => b.id === dragState.ballId);
  if (!ball) return;
  dragState.originX = ball.x;
  dragState.originY = ball.y;
  const dx = dragState.pointerX - ball.x, dy = dragState.pointerY - ball.y;
  const pullLength = Math.hypot(dx, dy);
  if (pullLength < 1) return;
  const dirX = -dx / pullLength, dirY = -dy / pullLength;
  const len = Math.min(pullLength, 90);
  const power = len / 90;   // 強さ（最大 90）
  const endX = ball.x + dirX * len * 1.3, endY = ball.y + dirY * len * 1.3;
  const col = pullLength < 6 ? 'rgba(150,150,150,0.8)' : power >= 1 ? 'rgba(224,67,90,0.95)' : 'rgba(255,179,71,0.95)';   // 弱すぎ: 灰 / 最大: 赤
  ctx.beginPath();
  ctx.moveTo(dragState.pointerX, dragState.pointerY);
  ctx.lineTo(endX, endY);
  ctx.lineWidth = 4;
  ctx.strokeStyle = col;
  ctx.stroke();
  const arrowSize = 12, angle = Math.atan2(dirY, dirX);
  ctx.beginPath();
  ctx.moveTo(endX, endY);
  ctx.lineTo(endX - arrowSize * Math.cos(angle - Math.PI / 6), endY - arrowSize * Math.sin(angle - Math.PI / 6));
  ctx.lineTo(endX - arrowSize * Math.cos(angle + Math.PI / 6), endY - arrowSize * Math.sin(angle + Math.PI / 6));
  ctx.closePath();
  ctx.fillStyle = col;
  ctx.fill();
}

// 上の表示: 陣地ごとの玉の数（名前つき。いちばん少ない人に王冠）と残り時間
function updateHud(counts) {
  const wrap = document.getElementById('zone-counts');
  wrap.innerHTML = '';
  if (!game.config) return;
  const min = Math.min(...counts), unique = counts.filter((c) => c === min).length === 1;   // いちばん少ない人が 1 人のときだけ王冠
  counts.forEach((c, z) => {
    const playerId = [...game.zoneAssignment.entries()].find(([, zone]) => zone === z)?.[0];
    const pill = document.createElement('span');
    pill.className = 'zone-pill' + (z === game.myZone ? ' mine' : '');
    pill.style.background = ZONE_COLORS[z % ZONE_COLORS.length];
    pill.textContent = `${c === min && unique ? '👑' : ''}${z === game.myZone ? 'あなた' : game.playerNames.get(playerId) || `相手${z + 1}`}: ${c}`;
    wrap.appendChild(pill);
  });
  const t = Math.ceil(game.timeLeftMs / 1000);
  const timer = document.getElementById('timer');
  timer.textContent = game.sudden ? 'サドンデス！' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  timer.classList.toggle('hot', game.sudden || t <= 15);
  const note = document.getElementById('game-note');
  note.textContent = game.isSpectator ? '観戦中（操作はできません）'
    : game.sudden ? '同点！ いちばん少ない人が 1 人になったら勝ち'
    : game.innerOpen ? '真ん中が開いた！ 時間切れのときは玉がいちばん少ない人の勝ち'
    : '自分の陣地の玉（白いふち）を引っ張って離すと発射。0個にするか、時間切れのときにいちばん少なければ勝ち';
}
game.onCounts = updateHud;

// ---- 入力: 自陣の玉をドラッグして引っ張り、離すと発射 ------------------
function canvasPointToBoard(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const s = view.scale;   // 盤面 1 単位あたりの画面のピクセル（CSS）
  const sx = (clientX - rect.left - rect.width / 2) / s, sy = (clientY - rect.top - rect.height / 2) / s;
  const cos = Math.cos(view.rotation), sin = Math.sin(view.rotation);
  return { x: cos * sx + sin * sy, y: -sin * sx + cos * sy };
}

canvas.addEventListener('pointerdown', (e) => {
  if (game.phase !== 'playing' || game.isSpectator) return;
  const p = canvasPointToBoard(e.clientX, e.clientY);
  const mine = new Set(game.getMyZoneBallIds());
  let closest = null, closestDist = Infinity;
  game.getRenderBalls().forEach((b) => {
    if (!mine.has(b.id)) return;
    const d = Math.hypot(b.x - p.x, b.y - p.y);
    if (d < closestDist) { closestDist = d; closest = b; }
  });
  const reach = BALL_RADIUS_PX * (game.config.playerCount > 2 ? 3.5 : 2.5);   // 3〜4人の盤面は玉が小さく見えるので、つかめる範囲を広く
  if (closest && closestDist <= reach) {
    dragState = { ballId: closest.id, originX: closest.x, originY: closest.y, pointerX: p.x, pointerY: p.y, pointerId: e.pointerId };
    try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const p = canvasPointToBoard(e.clientX, e.clientY);
  dragState.pointerX = p.x;
  dragState.pointerY = p.y;
});
function endDrag(e) {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const pull = { x: dragState.originX - dragState.pointerX, y: dragState.originY - dragState.pointerY };
  if (e.type !== 'pointercancel') game.requestLaunch(dragState.ballId, pull);
  dragState = null;
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---- 描画ループ --------------------------------------------------------
function frame() {
  if (game.phase === 'playing' && game.config) {
    if (!network.isHost) game.smoothRenderPositions();
    drawBoard();
    drawBalls();
    drawDragLine();
    if (network.isHost) updateHud(game.counts);
  }
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---- ゲームの段階変化に応じて画面を切り替える ---------------------------
game.onPhaseChange = (phase) => {
  if (phase === 'countdown') {
    showScreen('game');
    resizeCanvas();
    updateHud(game.counts);
    const countdown = document.getElementById('countdown');
    countdown.classList.remove('hidden');
    let count = 3;
    countdown.textContent = count;
    const timer = setInterval(() => {
      count--;
      if (count > 0) countdown.textContent = count;
      else { clearInterval(timer); countdown.classList.add('hidden'); }
    }, 1000);
  } else if (phase === 'playing') {
    showScreen('game');
    resizeCanvas();
  } else if (phase === 'ended') {
    const title = document.getElementById('ended-title');
    const msg = document.getElementById('ended-message');
    const names = game.winnerZones.map((z) => {
      const id = [...game.zoneAssignment.entries()].find(([, zone]) => zone === z)?.[0];
      return game.playerNames.get(id) || `プレイヤー${z + 1}`;
    });
    const draw = game.winnerZones.length > 1;
    if (game.winnerZones.includes(game.myZone)) title.textContent = draw ? '🤝 引き分け（あなたも勝ち）' : '🎉 あなたの勝ち！';
    else title.textContent = draw ? '引き分け' : `${names[0]}の勝ち`;
    const counts = game.finalCounts || [];
    msg.innerHTML = '';
    const lead = document.createElement('p');
    lead.textContent = counts.some((c) => c === 0) ? '陣地の玉を 0 個にしました' : '時間切れ: 陣地の玉がいちばん少ない人の勝ち';
    msg.appendChild(lead);
    counts.forEach((c, z) => {
      const id = [...game.zoneAssignment.entries()].find(([, zone]) => zone === z)?.[0];
      const row = document.createElement('div');
      row.className = 'result-row';
      row.style.borderLeftColor = ZONE_COLORS[z % ZONE_COLORS.length];
      row.textContent = `${game.winnerZones.includes(z) ? '👑 ' : ''}${game.playerNames.get(id) || `プレイヤー${z + 1}`}：${c}個`;
      msg.appendChild(row);
    });
    document.getElementById('btn-back-to-lobby').textContent = PARTY ? (network.isHost ? 'もう一回（同じメンバー）' : '待機画面へ') : 'ロビーに戻る';
    document.getElementById('btn-games-end').classList.toggle('hidden', !PARTY);
    showScreen('ended');
  }
};

// ---- パーティ: 自動で部屋を作る・入る -----------------------------------
if (PARTY) {
  playerName = String(PARTY.name || 'ゲスト').slice(0, 12);
  document.body.classList.add('party');
  const back = document.createElement('button');
  back.id = 'ykgBack'; back.textContent = '← 一覧';
  back.addEventListener('click', () => { if (confirm('ゲーム一覧へ戻りますか？' + (PARTY.role === 'host' ? '（みんなも一覧へ戻ります）' : ''))) toGames(); });
  document.body.appendChild(back);
  showScreen('waiting');
  setupWaitingScreen(PARTY.role === 'host');
  const go = PARTY.role === 'host' ? hostRoom(playerName, PARTY.code) : joinRoom(playerName, PARTY.code);
  go.catch((e) => { console.error(e); alert('部屋につながりませんでした（ゲーム一覧へ戻ります）'); toGames(); });
} else showScreen('lobby');

// アプリとして入れたときに使うサービスワーカー（ミニゲーム集で 1 つ。1 つ上のフォルダにある）
try { if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) navigator.serviceWorker.register('../sw.js').catch(() => {}); } catch (e) {}
