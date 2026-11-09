import { Network } from './network.js';
import { Game, TEAM_NAMES } from './game.js';
import { BALL_RADIUS_PX, defaultBallsPer, clampBalls } from './board.js';
import { hasPhysics } from './physics.js';

// 2026-11-09: オフラインのとき（または ?offline=1 で試すとき）は、通信を使う画面（部屋を作る・入る・パーティ）を出さず、CPU と対戦だけにする
const isOffline = () => !navigator.onLine || /[?&]offline=1/.test(location.search);

// パーティ（you know games のゲーム一覧で作るグループ）から開いたとき（?party=1）は、番号を入れずに自動で部屋を作る・入る
const PARTY = (() => {
  if (isOffline()) return null;   // 2026-11-09: オフラインではパーティに入れないので、ふつうのロビー（CPU と対戦）を出す
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
window.__gomu = { game, network };   // 2026-11-09: 動作確認用（画面が隠れていても JS から動かせるように）

// ---- 2026-11-09: 部屋の参加者（人 → CPU の順）と、CPU・チーム戦の設定 ----------------
function memberIds() {
  const hostId = network.isHost ? network.selfId : network.prefix + network.roomCode;
  const ids = !network.isHost && network.rosterOrder ? [...network.rosterOrder] : [hostId, ...[...network.peers].filter((id) => id !== hostId)];
  if (network.isHost) ids.push(...network.cpus.keys());
  if (!network.isHost && !ids.includes(network.selfId)) ids.push(network.selfId);
  const players = ids.filter((id) => !network.spectators.has(id));
  const specs = ids.filter((id) => network.spectators.has(id));
  return { players, specs };
}
const seatCount = () => Math.min(memberIds().players.length, 4);
const teamLabel = (id) => (network.teamMode && network.teams.has(id) ? TEAM_NAMES[network.teams.get(id)] : '');
// チーム戦: まだチームがない人を、少ない方のチームへ入れる（席のない人のチームは消す）
function fillTeams() {
  if (!network.isHost || !network.teamMode) return;
  const seats = memberIds().players.slice(0, 4);
  for (const id of [...network.teams.keys()]) if (!seats.includes(id)) network.teams.delete(id);
  for (const id of seats) {
    if (network.teams.has(id)) continue;
    const a = [...network.teams.values()].filter((t) => t === 0).length, b = network.teams.size - a;
    network.teams.set(id, a <= b ? 0 : 1);
  }
}
// スタートできるか（できないときは理由）
function startProblem() {
  const n = seatCount();
  if (n < 2) return 'あと1人必要です（CPUも入れられます）';
  if (network.teamMode && n === 4) {
    const a = memberIds().players.slice(0, 4).filter((id) => network.teams.get(id) === 0).length;
    if (a !== 2) return 'チームを2人ずつにしてください';
  }
  if (!hasPhysics()) return 'ゲームの部品が読みこめていません（通信を確認してください）';
  return '';
}

// 2026-11-09: 玉の数（1人あたり）の部品。value: null = おまかせ（2人 4こ・3〜4人 3こ）/ n: いまの人数
function ballsControlHtml(value, n) {
  const eff = clampBalls(value ?? defaultBallsPer(Math.max(2, n)));
  return `<div class="seg yl-row bp-row"><button class="seg-btn" data-bp="-1" ${eff <= 1 ? 'disabled' : ''}>−</button><span class="bp-val">${eff}こ</span>`
    + `<button class="seg-btn" data-bp="1" ${eff >= 8 ? 'disabled' : ''}>＋</button><button class="seg-btn ${value == null ? 'on' : ''}" data-bp="auto">おまかせ</button></div>`;
}
function nextBalls(value, n, op) {
  if (op === 'auto') return null;
  return clampBalls((value ?? defaultBallsPer(Math.max(2, n))) + (+op));
}

// ホストの設定（CPU を入れる・外す / チーム戦）。パーティでは ykgLobby の「設定」に、ふつうの部屋では待機画面に出す
const hostSettingsEl = document.createElement('div');
hostSettingsEl.className = 'host-settings';
let addLevel = 'normal';
function renderHostSettings() {
  if (!network.isHost || network.local) return;
  fillTeams();
  const n = seatCount(), full = n >= 4;
  const lv = [['weak', 'よわい'], ['normal', 'ふつう'], ['strong', 'つよい']];
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  let h = `<div class="opt-label">CPUを入れる（つよさを選んで ＋）</div><div class="seg yl-row">${lv.map(([v, l]) => `<button class="seg-btn ${addLevel === v ? 'on' : ''}" data-lv="${v}">${l}</button>`).join('')}<button class="seg-btn" data-add="1" ${full ? 'disabled' : ''}>＋CPU</button></div>`;
  if (network.cpus.size) h += `<div class="hs-list">${[...network.cpus].map(([id, c]) => `<button class="seg-btn" data-rm="${id}">✕ ${esc(c.name)}</button>`).join('')}</div>`;
  h += `<div class="opt-label">玉の数（1人あたり・1〜8こ）</div>${ballsControlHtml(network.ballsPer, n)}`;
  h += `<div class="opt-label">チーム戦（4人のとき 2対2）</div><div class="seg yl-row"><button class="seg-btn ${network.teamMode ? '' : 'on'}" data-tm="0">なし</button><button class="seg-btn ${network.teamMode ? 'on' : ''}" data-tm="1">2対2</button></div>`;
  if (network.teamMode) {
    const seats = memberIds().players.slice(0, 4);
    h += `<div class="hs-list">${seats.map((id, i) => `<button class="seg-btn t${network.teams.get(id) ?? 0}" data-team="${id}">${esc(nameOf(id, i))}：${TEAM_NAMES[network.teams.get(id) ?? 0]}</button>`).join('')}</div>`;
    h += `<p class="hs-sub">${n === 4 ? '名前を押すとチームが変わります。向かい合う陣地が味方。チームの玉の合計で勝ち負け' : '4人そろうとチーム戦になります（今は' + n + '人）'}</p>`;
  }
  hostSettingsEl.innerHTML = h;
}
hostSettingsEl.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b || b.disabled || !network.isHost) return;
  if (b.dataset.lv) addLevel = b.dataset.lv;
  else if (b.dataset.add) { if (seatCount() < 4) network.addCpu(addLevel); }
  else if (b.dataset.rm) network.removeCpu(b.dataset.rm);
  else if (b.dataset.tm) network.setTeamMode(b.dataset.tm === '1');
  else if (b.dataset.team) network.setTeam(b.dataset.team, network.teams.get(b.dataset.team) === 0 ? 1 : 0);
  else if (b.dataset.bp) network.setBallsPer(nextBalls(network.ballsPer, seatCount(), b.dataset.bp));
  fillTeams(); network._sendRoster();
  renderPlayerList();
});

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
const LOBBY_RULES = '自分の陣地の玉をゴムで弾いて相手の陣地へ送る。先に陣地の玉を0個にした人の勝ち。指2本で同時に撃てる。\n制限時間は2人90秒・3〜4人120秒。時間切れは玉がいちばん少ない人の勝ち（3〜4人は半分を過ぎると真ん中が開く）。';
function partyLobby() {
  if (!PARTY || !window.ykgLobby || document.body.dataset.screen !== 'waiting') return;
  const { players, specs } = lobbyReady ? memberIds() : { players: [], specs: [] };
  const members = lobbyReady ? [
    ...players.map((id, i) => ({ name: nameOf(id, i), tag: [i === 0 ? 'ホスト' : i >= 4 ? (network.cpuIds.has(id) ? '休み' : '観戦') : '', network.cpuIds.has(id) ? 'CPU' : '', i < 4 ? teamLabel(id) : ''].filter(Boolean).join('・'), me: id === network.selfId })),
    ...specs.map((id) => ({ name: nameOf(id), tag: '観戦', me: id === network.selfId })),
  ] : [{ name: playerName, tag: network.isHost || PARTY.role === 'host' ? 'ホスト' : '', me: true }];
  const n = Math.min(players.length, 4);
  const opts = { rules: LOBBY_RULES, members, settings: null };
  if (PARTY.role === 'host') {
    const prob = lobbyReady ? startProblem() : '';
    if (lobbyReady) { renderHostSettings(); opts.settings = hostSettingsEl; }
    opts.button = { label: 'スタート', disabled: !lobbyReady || !!prob, onClick: () => { try { game.startAsHost(); } catch (e) { console.error(e); } } };
    opts.status = !lobbyReady ? '部屋を準備しています…' : prob || `${n}人で遊びます${network.teamMode && n === 4 ? '（チーム戦）' : ''}`;
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
  if (isOffline()) { lobbyError.textContent = 'オフラインです。CPUと対戦で遊べます。'; return; }
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
  if (isOffline()) { lobbyError.textContent = 'オフラインです。CPUと対戦で遊べます。'; return; }
  lobbyError.textContent = 'つないでいます…';
  try { await joinRoom(playerName, code); lobbyError.textContent = ''; }
  catch (e) { console.error(e); lobbyError.textContent = '部屋が見つかりません。部屋コードを確認してください。'; }
});

// ---- 待機画面 ----------------------------------------------------------
function renderPlayerList() {
  if (network.local) return;
  if (network.isHost) renderHostSettings();
  const list = document.getElementById('player-list');
  const { players, specs } = memberIds();
  document.getElementById('player-count').textContent = Math.min(players.length, 4);
  list.innerHTML = '';
  players.forEach((id, i) => {
    const li = document.createElement('li');
    const cpu = network.cpuIds.has(id);
    li.textContent = nameOf(id, i) + (i === 0 ? ' (ホスト)' : '') + (i >= 4 ? (cpu ? '（席がないので休み）' : '（5人目以降は観戦）') : '');
    const tl = i < 4 ? teamLabel(id) : '';
    if (tl) { const chip = document.createElement('span'); chip.className = `team-chip t${network.teams.get(id)}`; chip.textContent = tl; li.appendChild(chip); }
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
  const prob = network.isHost ? startProblem() : '';
  if (network.isHost) startBtn.disabled = !!prob;
  const bpNote = network.ballsPer != null ? `玉は1人${network.ballsPer}こ` : '';
  document.getElementById('start-note').textContent = network.isHost ? (prob || (network.teamMode && seatCount() < 4 ? 'チーム戦は4人のときだけ（今はふつうの対戦になります）' : '')) : [network.teamMode ? 'チーム戦（2対2）' : '', bpNote].filter(Boolean).join('・');
  partyLobby();
}

function setupWaitingScreen(isHost) {
  document.getElementById('host-only-note').classList.toggle('hidden', !isHost);
  document.getElementById('btn-start-game').classList.toggle('hidden', !isHost);
  document.getElementById('guest-wait-note').classList.toggle('hidden', isHost);
  document.getElementById('room-code-card').classList.toggle('hidden', !!PARTY);
  const slot = document.getElementById('host-settings-slot');
  if (isHost && !PARTY && hostSettingsEl.parentNode !== slot) slot.appendChild(hostSettingsEl);
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
  if (network.local) { startCpuGame(); return; }   // CPU と対戦: 同じ設定でもう一回
  if (PARTY && network.isHost) { setupWaitingScreen(true); showScreen('waiting'); game.phase = 'lobby'; return; }   // ホスト: もう一回（同じ部屋で）
  if (PARTY) { setupWaitingScreen(false); showScreen('waiting'); game.phase = 'lobby'; return; }
  location.reload();
});
document.getElementById('btn-games').addEventListener('click', toGames);
document.getElementById('btn-games-end').addEventListener('click', () => { if (network.local) location.reload(); else toGames(); });

// ---- ゲーム画面: キャンバス描画 ---------------------------------------
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
// 2026-11-09: 指ごとに別々に引っ張れるように（2 本の指で 2 つの玉を同時に撃てる）。pointerId -> { ballId, originX, originY, pointerX, pointerY }
const drags = new Map();
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
    ctx.fillStyle = game.zoneColor(z);
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
    const name = (game.playerNames.get(playerId) || `プレイヤー${z + 1}`) + (game.teams ? `（${TEAM_NAMES[game.teams[z]]}）` : '');
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

function drawDragLines() {
  if (!drags.size) return;
  const balls = game.getRenderBalls();
  for (const d of drags.values()) drawDragLine(d, balls.find((b) => b.id === d.ballId));
}
function drawDragLine(dragState, ball) {
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
  // 2026-11-09: チーム戦はチームの合計を先に出す（王冠もチームに）
  if (game.teams) {
    const tt = game.teamTotals(counts), tmin = Math.min(...tt), myTeam = game.teamOfZone(game.myZone);
    tt.forEach((c, t) => {
      const pill = document.createElement('span');
      pill.className = 'zone-pill' + (t === myTeam ? ' mine' : '');
      pill.style.background = t === 0 ? '#e0523d' : '#3f7fd1';
      pill.textContent = `${c === tmin && tt[0] !== tt[1] ? '👑' : ''}${TEAM_NAMES[t]}${t === myTeam ? '（味方）' : ''}: ${c}`;
      wrap.appendChild(pill);
    });
  }
  const min = Math.min(...counts), unique = !game.teams && counts.filter((c) => c === min).length === 1;   // いちばん少ない人が 1 人のときだけ王冠
  counts.forEach((c, z) => {
    const playerId = [...game.zoneAssignment.entries()].find(([, zone]) => zone === z)?.[0];
    const pill = document.createElement('span');
    pill.className = 'zone-pill' + (z === game.myZone ? ' mine' : '');
    pill.style.background = game.zoneColor(z);
    if (game.teams) pill.style.opacity = '0.85';
    pill.textContent = `${c === min && unique ? '👑' : ''}${z === game.myZone ? 'あなた' : game.playerNames.get(playerId) || `相手${z + 1}`}: ${c}`;
    wrap.appendChild(pill);
  });
  const t = Math.ceil(game.timeLeftMs / 1000);
  const timer = document.getElementById('timer');
  timer.textContent = game.sudden ? 'サドンデス！' : `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
  timer.classList.toggle('hot', game.sudden || t <= 15);
  const note = document.getElementById('game-note');
  note.textContent = game.isSpectator ? '観戦中（操作はできません）'
    : game.sudden ? (game.teams ? '同点！ 合計が少ないチームが決まったら勝ち' : '同点！ いちばん少ない人が 1 人になったら勝ち')
    : game.teams && !game.innerOpen ? 'チーム戦: となりは相手、向かいは味方。チームの玉の合計を0にするか、時間切れで少ない方の勝ち'
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
  const busy = new Set([...drags.values()].map((d) => d.ballId));   // ほかの指がつかんでいる玉はつかまない
  let closest = null, closestDist = Infinity;
  game.getRenderBalls().forEach((b) => {
    if (!mine.has(b.id) || busy.has(b.id)) return;
    const d = Math.hypot(b.x - p.x, b.y - p.y);
    if (d < closestDist) { closestDist = d; closest = b; }
  });
  const reach = BALL_RADIUS_PX * (game.config.playerCount > 2 ? 3.5 : 2.5);   // 3〜4人の盤面は玉が小さく見えるので、つかめる範囲を広く
  if (closest && closestDist <= reach) {
    drags.set(e.pointerId, { ballId: closest.id, originX: closest.x, originY: closest.y, pointerX: p.x, pointerY: p.y });
    try { canvas.setPointerCapture(e.pointerId); } catch (x) {}
  }
});
canvas.addEventListener('pointermove', (e) => {
  const d = drags.get(e.pointerId); if (!d) return;
  const p = canvasPointToBoard(e.clientX, e.clientY);
  d.pointerX = p.x;
  d.pointerY = p.y;
});
function endDrag(e) {
  const d = drags.get(e.pointerId); if (!d) return;
  drags.delete(e.pointerId);
  const pull = { x: d.originX - d.pointerX, y: d.originY - d.pointerY };
  if (e.type !== 'pointercancel' && game.phase === 'playing') game.requestLaunch(d.ballId, pull);   // 指ごとに別の発射として送る
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);

// ---- 描画ループ --------------------------------------------------------
function frame() {
  if (game.phase === 'playing' && game.config) {
    if (!network.isHost) game.smoothRenderPositions();
    drawBoard();
    drawBalls();
    drawDragLines();
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
    const counts = game.finalCounts || [];
    msg.innerHTML = '';
    const lead = document.createElement('p');
    if (game.teams) {
      // 2026-11-09: チーム戦
      const wt = [...new Set(game.winnerZones.map((z) => game.teams[z]))], myTeam = game.teamOfZone(game.myZone);
      const tt = game.teamTotals(counts);
      if (wt.length !== 1) title.textContent = '🤝 引き分け';
      else if (myTeam != null && wt[0] === myTeam) title.textContent = `🎉 あなたのチーム（${TEAM_NAMES[myTeam]}）の勝ち！`;
      else title.textContent = `${TEAM_NAMES[wt[0]]}チームの勝ち`;
      lead.textContent = (tt.some((c) => c === 0) ? 'チームの玉を 0 個にしました' : '時間切れ: チームの玉の合計が少ない方の勝ち') + `（あか ${tt[0]} ／ あお ${tt[1]}）`;
    } else {
      const draw = game.winnerZones.length > 1;
      if (game.winnerZones.includes(game.myZone)) title.textContent = draw ? '🤝 引き分け（あなたも勝ち）' : '🎉 あなたの勝ち！';
      else title.textContent = draw ? '引き分け' : `${names[0]}の勝ち`;
      lead.textContent = counts.some((c) => c === 0) ? '陣地の玉を 0 個にしました' : '時間切れ: 陣地の玉がいちばん少ない人の勝ち';
    }
    msg.appendChild(lead);
    counts.forEach((c, z) => {
      const id = [...game.zoneAssignment.entries()].find(([, zone]) => zone === z)?.[0];
      const row = document.createElement('div');
      row.className = 'result-row';
      row.style.borderLeftColor = game.zoneColor(z);
      row.textContent = `${game.winnerZones.includes(z) ? '👑 ' : ''}${game.playerNames.get(id) || `プレイヤー${z + 1}`}${game.teams ? `（${TEAM_NAMES[game.teams[z]]}）` : ''}：${c}個`;
      msg.appendChild(row);
    });
    document.getElementById('btn-back-to-lobby').textContent = network.local ? 'もう一回' : PARTY ? (network.isHost ? 'もう一回（同じメンバー）' : '待機画面へ') : 'ロビーに戻る';
    document.getElementById('btn-games-end').classList.toggle('hidden', !PARTY && !network.local);
    document.getElementById('btn-games-end').textContent = network.local ? 'メニューに戻る' : '← ゲーム一覧へ';
    showScreen('ended');
  }
};

// ---- 2026-11-09: CPU と対戦（ロビー）とオフライン表示 ------------------
const cpuOpt = { count: 1, level: 'normal', team: false, balls: null };
function renderCpuCard() {
  document.querySelectorAll('#cpu-count .seg-btn').forEach((b) => b.classList.toggle('on', +b.dataset.v === cpuOpt.count));
  document.querySelectorAll('#cpu-level .seg-btn').forEach((b) => b.classList.toggle('on', b.dataset.v === cpuOpt.level));
  const teamOk = cpuOpt.count === 3;   // チーム戦は 4 人（あなた＋CPU3人）のときだけ
  const cb = document.getElementById('cpu-team');
  cb.disabled = !teamOk; cb.checked = teamOk && cpuOpt.team;
  document.getElementById('cpu-team-row').classList.toggle('off', !teamOk);
  document.getElementById('cpu-balls').innerHTML = ballsControlHtml(cpuOpt.balls, cpuOpt.count + 1);
}
document.getElementById('cpu-balls').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b && !b.disabled) { cpuOpt.balls = nextBalls(cpuOpt.balls, cpuOpt.count + 1, b.dataset.bp); renderCpuCard(); } });
document.getElementById('cpu-count').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) { cpuOpt.count = +b.dataset.v; renderCpuCard(); } });
document.getElementById('cpu-level').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) { cpuOpt.level = b.dataset.v; renderCpuCard(); } });
document.getElementById('cpu-team').addEventListener('change', (e) => { cpuOpt.team = e.target.checked; renderCpuCard(); });
function startCpuGame() {
  if (!hasPhysics()) { lobbyError.textContent = 'ゲームの部品が読みこめませんでした。通信できるときに一度開いてください。'; return; }
  if (!network.local) {
    playerName = playerNameInput.value.trim() || 'あなた';
    try { if (playerNameInput.value.trim()) localStorage.setItem('gomu-name', playerName); } catch (e) {}
    network.startLocal(playerName);
  }
  // CPU を入れ直す（もう一回のときも同じ設定で）
  for (const id of [...network.cpus.keys()]) network.removeCpu(id);
  network.cpuSeq = 0;   // 名前は毎回 CPU1 から
  network.teams.clear();
  const ids = [];
  for (let i = 0; i < cpuOpt.count; i++) ids.push(network.addCpu(cpuOpt.level));
  network.teamMode = cpuOpt.team && cpuOpt.count === 3;
  network.ballsPer = cpuOpt.balls;
  if (network.teamMode) { network.teams.set(network.selfId, 0); network.teams.set(ids[0], 0); network.teams.set(ids[1], 1); network.teams.set(ids[2], 1); }
  try { game.startAsHost(); } catch (e) { console.error(e); lobbyError.textContent = 'はじめられませんでした。'; }
}
document.getElementById('btn-cpu-start').addEventListener('click', () => { lobbyError.textContent = ''; startCpuGame(); });
renderCpuCard();

function applyOffline() {
  const off = isOffline();
  document.querySelectorAll('.online-only').forEach((el) => el.classList.toggle('hidden', off));
  document.getElementById('offline-note').classList.toggle('hidden', !off);
}
window.addEventListener('online', applyOffline);
window.addEventListener('offline', applyOffline);
applyOffline();

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
