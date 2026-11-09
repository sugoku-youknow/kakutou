// network.js
// 通信は PeerJS（シールドファイトと同じ方式。2026-11-06 に Trystero から変更）。
// 「部屋を作った人がホスト」。ホストだけが物理演算(Matter.js)を動かし、ゲストは入力(発射)をホストへ送るだけ（ホスト権威型）。
// ゲストどうしは直接つながらず、ホストがまとめて配る（参加者の名前の一覧 roster もホストが配る）。
//
// 玉の位置（state）は、届き直しをしない・順番を待たないデータチャンネル（落としてよい通り道）で送る。
// なくなった位置は捨てて次の新しいものを使うので、回線が不安定でもカクつきにくい（シールドファイトと同じ）。開けないときはふつうの接続で送る。
//
// パーティ（you know games のゲーム一覧で作るグループ）から開いたときは、パーティの番号で部屋を作る・入る。
// 観戦を選んだ人（spec）は、玉を割り当てられずに見るだけになる。

const PREFIX = 'gomu-room-';          // ふつうの部屋の PeerJS の ID の頭
const PARTY_PREFIX = 'gomu-party-';   // パーティの部屋
const UCH_ID = 9;                     // 落としてよい通り道のチャンネル番号（両側で同じ番号で作る）

export function generateRoomCode() {
  return String(Math.floor(Math.random() * 10));
}

function openUch(conn, onMsg) {
  try {
    const pc = conn && conn.peerConnection;
    if (!pc || !pc.createDataChannel) return null;
    const ch = pc.createDataChannel('gomu-u', { negotiated: true, id: UCH_ID, ordered: false, maxRetransmits: 0 });
    ch.onmessage = (e) => { if (typeof e.data === 'string') onMsg(e.data); };
    return ch;
  } catch (e) { return null; }
}
const uchOpen = (ch) => !!ch && ch.readyState === 'open';

export class Network {
  constructor(party) {
    this.party = party || null;
    this.peer = null;
    this.isHost = false;
    this.roomCode = null;
    this.playerName = '';
    this.playerNames = new Map();   // peerId -> 名前
    this.spectators = new Set();    // 観戦の peerId
    this.peers = new Set();         // 自分以外の参加者（ゲストから見るとホストとほかのゲスト）
    this.conns = new Map();         // ホスト: peerId -> { conn, uch }
    this.hostConn = null; this.uch = null;
    this.onPeerJoin = () => {};
    this.onPeerLeave = () => {};
    this.onPlayerName = () => {};
    this.onHostLost = () => {};     // ゲスト: ホストとの接続が切れた
    this.handlers = {};
    this.stateSeq = 0; this.lastStateSeq = 0;
    this.tries = 0;
    // 2026-11-09: CPU とチーム戦。CPU はホストの中だけで動き、ゲストには名簿（roster）で「CPU の席」として伝える
    this.cpus = new Map();          // ホスト: cpuId -> { name, level }
    this.cpuIds = new Set();        // だれが CPU か（ゲストも名簿から知る）
    this.cpuSeq = 0;
    this.teamMode = false;          // チーム戦（4人のとき 2対2）
    this.ballsPer = null;           // 1 人あたりの玉の数（null = 人数で決める。ホストが変えられる）
    this.teams = new Map();         // peerId / cpuId -> 0（あか）| 1（あお）
    this.local = false;             // CPU と対戦（通信なし。オフラインでも遊べる）
    this._localId = null;
  }

  get selfId() { return this.peer ? this.peer.id : this._localId; }
  static get available() { return typeof Peer === 'function'; }   // PeerJS が読みこめたか（オフラインだと無いことがある）

  // CPU と対戦: 通信せずに自分がホストになる（send はだれにも送らない）
  startLocal(playerName) {
    this.isHost = true; this.local = true;
    this.playerName = playerName;
    this._localId = 'local-me';
    this.playerNames.set(this._localId, playerName);
  }

  // ---------- CPU の出し入れ（ホストだけ） ----------
  addCpu(level) {
    const id = `cpu-${++this.cpuSeq}`;
    const lv = { weak: 'よわい', normal: 'ふつう', strong: 'つよい' }[level] || 'ふつう';
    const name = `CPU${this.cpuSeq}・${lv}`;
    this.cpus.set(id, { name, level });
    this.cpuIds.add(id);
    this.playerNames.set(id, name);
    this._sendRoster();
    return id;
  }
  removeCpu(id) {
    this.cpus.delete(id); this.cpuIds.delete(id); this.teams.delete(id);
    this._sendRoster();
  }
  setTeamMode(on) { this.teamMode = !!on; this._sendRoster(); }
  setBallsPer(v) { this.ballsPer = v; this._sendRoster(); }
  setTeam(id, t) { this.teams.set(id, t ? 1 : 0); this._sendRoster(); }
  get prefix() { return this.party ? PARTY_PREFIX : PREFIX; }

  on(action, cb) { this.handlers[action] = cb; }
  _emit(action, data, from) { const h = this.handlers[action]; if (h) h(data, { peerId: from }); }

  // ---------- ホスト ----------
  createRoom(playerName, code) {
    this.isHost = true;
    this.playerName = playerName;
    code = code ?? generateRoomCode();
    return new Promise((resolve, reject) => {
      if (!Network.available) { reject(new Error('PeerJS not loaded')); return; }   // 2026-11-09: オフラインで PeerJS が無いとき
      const peer = this.peer = new Peer(this.prefix + code);
      peer.on('open', () => {
        this.roomCode = code;
        this.playerNames.set(peer.id, playerName);
        resolve(code);
      });
      peer.on('error', (err) => {
        if (err.type === 'unavailable-id' && ++this.tries < 90) {   // 番号が使われている（パーティなら前の部屋が残っている）
          try { peer.destroy(); } catch (e) {}
          setTimeout(() => this.createRoom(playerName, this.party ? code : null).then(resolve, reject), this.party ? 1000 : 0);
          return;
        }
        if (this.roomCode == null) reject(err);
      });
      peer.on('connection', (conn) => this._acceptGuest(conn));
    });
  }

  _acceptGuest(conn) {
    conn.on('open', () => {
      const id = conn.peer;
      const entry = { conn, uch: openUch(conn, () => {}) };
      this.conns.set(id, entry);
      this.peers.add(id);
      if (conn.metadata && conn.metadata.spec) this.spectators.add(id);
      conn.on('data', (m) => {
        if (!m || !m.a) return;
        if (m.a === 'name') {
          this.playerNames.set(id, String(m.d.name || 'ゲスト').slice(0, 12));
          this.onPlayerName(id, m.d.name);
          this._sendRoster();
          return;
        }
        this._emit(m.a, m.d, id);
      });
      conn.on('close', () => {
        if (this.conns.get(id)?.conn !== conn) return;
        this.conns.delete(id); this.peers.delete(id); this.spectators.delete(id);
        this.onPeerLeave(id);
        this._sendRoster();
      });
      this.onPeerJoin(id);
      this._sendRoster();
    });
  }

  // 参加者の一覧（名前・観戦か）をみんなへ
  _sendRoster() {
    // 2026-11-09: [id, 名前, 観戦か, チーム, CPU か]。CPU は人のあとに並べる。tm はチーム戦か
    const ent = (id, name, spec) => [id, name, spec, this.teams.has(id) ? this.teams.get(id) : -1, this.cpuIds.has(id)];
    const list = [ent(this.selfId, this.playerName, false), ...[...this.peers].map((id) => ent(id, this.playerNames.get(id) || '', this.spectators.has(id))),
      ...[...this.cpus].map(([id, c]) => ent(id, c.name, false))];
    for (const { conn } of this.conns.values()) { try { conn.send({ a: 'roster', d: list, tm: this.teamMode, bp: this.ballsPer }); } catch (e) {} }
    this.onPlayerName();
  }

  // ---------- ゲスト ----------
  joinRoom(roomCode, playerName) {
    this.isHost = false;
    this.playerName = playerName;
    this.roomCode = roomCode;
    return new Promise((resolve, reject) => {
      let done = false, peer = null;
      if (!Network.available) { reject(new Error('PeerJS not loaded')); return; }   // 2026-11-09: オフラインで PeerJS が無いとき
      // つながらないときは、ときどき peer から作り直す（PeerJS が止まったままになるのを避ける）
      const newPeer = () => {
        try { peer && peer.destroy(); } catch (e) {}
        peer = this.peer = new Peer();
        peer.on('open', connect);
        peer.on('error', (err) => {
          if (err.type === 'peer-unavailable') return;   // 下の時間切れでつなぎ直す
          if (!done) { done = true; reject(err); }
        });
      };
      const connect = () => {
        const c = this.hostConn = peer.connect(this.prefix + roomCode, { reliable: true, metadata: { spec: !!(this.party && this.party.spec) } });
        // PeerJS は「相手が見つからない」を知らせないまま止まることがあるので、2.5 秒でつながらなければつなぎ直す
        setTimeout(() => {
          if (this.hostConn !== c || c.open) return;
          try { c.close(); } catch (e) {}
          if (++this.tries > (this.party ? 60 : 4)) { if (!done) { done = true; reject(new Error('not found')); } return; }
          if (this.tries % 3 === 0) newPeer(); else connect();
        }, 2500);
        c.on('open', () => {
          c.opened = true;
          this.playerNames.set(peer.id, playerName);
          this.uch = openUch(c, (str) => {
            let m; try { m = JSON.parse(str); } catch (e) { return; }
            this._onHostMessage(m);
          });
          c.send({ a: 'name', d: { name: playerName } });
          if (!done) { done = true; resolve(); }
        });
        c.on('data', (m) => this._onHostMessage(m));
        c.on('close', () => { if (this.hostConn === c && c.opened) this.onHostLost(); });
      };
      newPeer();
    });
  }

  _onHostMessage(m) {
    if (!m || !m.a) return;
    if (m.a === 'roster') {
      const host = this.prefix + this.roomCode;
      this.peers = new Set(m.d.map(([id]) => id).filter((id) => id !== this.selfId));
      this.spectators = new Set(m.d.filter(([, , s]) => s).map(([id]) => id));
      m.d.forEach(([id, name]) => this.playerNames.set(id, name));
      this.rosterOrder = m.d.map(([id]) => id);   // 名簿の順（人 → CPU）
      this.cpuIds = new Set(m.d.filter((e) => e[4]).map(([id]) => id));
      this.teams = new Map(m.d.filter((e) => e[3] === 0 || e[3] === 1).map((e) => [e[0], e[3]]));
      this.teamMode = !!m.tm;
      this.ballsPer = m.bp ?? null;
      this.onPlayerName(host, this.playerNames.get(host));
      return;
    }
    if (m.a === 'state') {   // 順番が入れ替わって届くことがあるので、番号の古いものは捨てる
      if (m.q <= this.lastStateSeq) return;
      this.lastStateSeq = m.q;
    }
    this._emit(m.a, m.d, this.prefix + this.roomCode);
  }

  // ---------- 送る ----------
  // ホスト: みんなへ（target を指定すればその人だけ）/ ゲスト: ホストへ
  send(action, data, target) {
    if (this.isHost) {
      const msg = { a: action, d: data };
      if (action === 'state') msg.q = ++this.stateSeq;
      const str = action === 'state' ? JSON.stringify(msg) : null;
      for (const [id, { conn, uch }] of this.conns) {
        if (target && id !== target) continue;
        if (!conn.open) continue;
        try {
          if (str && uchOpen(uch) && str.length < 16000) { if (uch.bufferedAmount < 32000) uch.send(str); }
          else conn.send(msg);
        } catch (e) {}
      }
      return;
    }
    if (this.hostConn && this.hostConn.open) { try { this.hostConn.send({ a: action, d: data }); } catch (e) {} }
  }

  leave() {
    try { this.peer?.destroy(); } catch (e) {}
    this.peer = null;
  }
}
