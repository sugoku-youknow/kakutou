// party-beacon.js（2026-11-06 作成、2026-11-07 に作り直し）
// すべてのゲームのページで PeerJS のすぐあとに読み込む。ゲームごとの通信とは別の、パーティ共通の「合図の通り道」。
//
// 1. 通信の道を増やす: PeerJS の Peer に STUN サーバーを足す（直接つながりやすくなり、遠くの中継を通らずにすむ = ラグが減る）。
// 2. ホストがゲームの中にいるあいだ、パーティの番号（ykg-party-番号）で待ち受ける。
//    - ゲーム一覧から遅れてつながってきたゲスト → 「このゲームへ」（go）と伝えて同じゲームへ来てもらう。
//    - ゲームの中のゲスト → つながったままにして、ホストが一覧へ戻るとき「戻って」（back）と伝える。
// 3. ゲストはゲームの中で、ホストの待ち受けにつながっておく。
//    - back が来た、またはつながりが切れた（ホストがページを離れた。Android の戻るも）→ ゲーム一覧へ。
//    - ホストが別のゲームにいる → そのゲームへ。ホストが一覧にいる → 一覧へ。
// 4. どの戻り方（ゲームの中のボタン・Android の戻る）でも、ゲーム一覧へは同じ ykgToGames() で戻る。
//    履歴を積まない（location.replace）ので、戻るで前のゲームのページが開き直されることがない。
// 5. パーティの待ち合わせ画面 ykgLobby（2026-11-07）: どのゲームでも、ゲームを開いて最初に出る画面を同じ構図にする。
//    名前の変更はゲーム一覧（ホーム）でだけ行う（待ち合わせ画面には出さない）。
(function () {
  // ---------- 1. STUN を足す ----------
  if (typeof Peer === "function" && !Peer.__ykg) {
    const ICE = {
      iceServers: [
        { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
        { urls: "stun:stun.cloudflare.com:3478" },
        { urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp" },
      ],
      sdpSemantics: "unified-plan",
    };
    const P = Peer;
    // 合図の中継（PeerJS のサーバー）との接続だけが切れたときのエラー。相手とのつながりはそのまま生きている
    const SIGNAL = new Set(["network", "socket-error", "socket-closed", "server-error", "disconnected", "unavailable-id"]);   // unavailable-id: つなぎ直しのときに前の自分がまだ残っている
    const YP = function (id, opts) {
      if (id && typeof id === "object") { opts = id; id = undefined; }
      opts = Object.assign({ config: ICE }, opts || {});
      const p = id === undefined ? new P(opts) : new P(id, opts);
      // 一度つながったあとで中継との接続が切れたら、エラーにせずにつなぎ直す
      // （前は「接続エラー: network」でホストの部屋が止まり、ゲストが「ホストを探しています」のままになっていた）
      p.once("open", () => { p._ykgOpened = true; });
      const on = p.on.bind(p);
      p.on = (ev, fn) => on(ev, ev === "error" ? (e => { if (p._ykgOpened && e && SIGNAL.has(e.type)) return; fn(e); }) : fn);
      let wait = 1000;
      on("disconnected", () => {
        const again = () => {
          if (p.destroyed || !p.disconnected) { wait = 1000; return; }
          try { p.reconnect(); } catch (e) {}
          wait = Math.min(wait * 2, 8000);
          setTimeout(again, wait);
        };
        setTimeout(again, 500);
      });
      on("open", () => { wait = 1000; });
      on("error", () => {});   // 上で拾ったエラーで止まらないように
      return p;
    };
    YP.prototype = P.prototype; YP.__ykg = true;
    window.Peer = YP;
  }

  // このタブの決まった ID（つなぎ直しても同じ人だとわかるように。2 人用のゲームで、つなぎ直した人が観戦にされないように）
  try {
    let t = sessionStorage.getItem("ykg-tab");
    if (!t) { t = Math.random().toString(36).slice(2, 10); sessionStorage.setItem("ykg-tab", t); }
    window.ykgTabId = t;
  } catch (e) { window.ykgTabId = Math.random().toString(36).slice(2, 10); }

  let party = null;
  try { party = JSON.parse(sessionStorage.getItem("ykg-party") || "null"); } catch (e) {}
  const inParty = !!(party && party.code != null && /[?&]party=1/.test(location.search));
  if (!inParty) {
    window.ykgToGames = () => { location.href = "../"; };
    window.ykgLobby = { open() {}, update() {}, close() {}, closeAll() {}, active: false };
    return;
  }

  const isHost = party.role === "host";
  const game = location.pathname.replace(/\/(index\.html)?$/, "").split("/").pop() + "/";   // 例: "soinsu/"
  const ID = "ykg-party-" + party.code;
  const guestConns = new Map();   // ホスト: ゲームの中のゲストとのつながり -> { name, spec }
  let peer = null, leaving = false;

  function toGuests(m) { for (const c of guestConns.keys()) { try { c.send(m); } catch (e) {} } }
  function sendBack() { toGuests({ t: "back" }); }
  // ゲーム一覧へ戻る（ホストはみんなに知らせてから）
  window.ykgToGames = function () {
    if (leaving) return; leaving = true;
    if (isHost) { sendBack(); setTimeout(() => location.replace("../"), 300); }
    else location.replace("../");
  };
  function goGame(g) { if (leaving) return; leaving = true; location.replace("../" + g + "?party=1"); }

  // Android の戻る: 履歴を 1 つ足しておき、戻るが押されたら一覧へ（みんなも一緒に）
  try { history.pushState({ ykg: 1 }, ""); addEventListener("popstate", () => window.ykgToGames()); } catch (e) {}
  // 戻る・進むでページが凍ったまま戻ってきたら、読み込み直す（古い通信のまま動かないように）
  addEventListener("pageshow", e => { if (e.persisted) location.reload(); });
  addEventListener("pagehide", () => { if (isHost) sendBack(); try { peer && peer.destroy(); } catch (e) {} });

  // ================= 5. パーティの待ち合わせ画面（全部のゲームで同じ構図） =================
  // 上: ← 一覧・ゲーム名・パーティの番号 / 参加者 / 遊び方 / 設定（ホストだけ操作できる） / 下: 大きいボタン（または待っている表示）
  // ゲームは ykgLobby.open({...}) で出し、update({...}) で中身を変え、試合が始まったら close() で閉じる。
  //   rules: 遊び方の文 / settings: 設定の要素（HTMLElement）か HTML の文字列 / members: [{ name, tag, me }]（省略するとパーティの合図の通り道で集めた人）
  //   button: { label, onClick, disabled }（null なら wait の文を出す） / wait: ボタンがないときの文 / status: 小さい補足の文
  const lobbyState = { opts: null, el: null, started: false, remoteStarted: false, members: [] };
  const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function lobbyCss() {
    if (document.getElementById("ykgLobbyCss")) return;
    const st = document.createElement("style"); st.id = "ykgLobbyCss";
    st.textContent = `
#ykgLobby{position:fixed;inset:0;z-index:2147483000;display:flex;flex-direction:column;background:#111827;color:#e5e7eb;
  font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;-webkit-tap-highlight-color:transparent;
  padding:env(safe-area-inset-top) 0 env(safe-area-inset-bottom)}
#ykgLobby *{box-sizing:border-box}
#ykgLobby button{margin:0;width:auto;min-width:0;height:auto;box-shadow:none;text-transform:none;letter-spacing:normal;line-height:1.2;cursor:pointer}
#ykgLobby .yl-top{flex:none;display:flex;align-items:center;gap:10px;height:56px;padding:0 12px;border-bottom:1px solid #2c3a52}
#ykgLobby .yl-back{flex:none;font:inherit;font-size:14px;font-weight:700;padding:8px 12px;border-radius:99px;border:1px solid #2c3a52;background:#1c2636;color:#e5e7eb}
#ykgLobby .yl-title{flex:1;text-align:center;font-size:18px;font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#ykgLobby .yl-code{flex:none;font-size:13px;color:#9aa3b5;white-space:nowrap}
#ykgLobby .yl-code b{color:#f0b25a;font-size:20px;margin-left:4px}
#ykgLobby .yl-body{flex:1;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;max-width:520px;width:100%;margin:0 auto}
#ykgLobby .yl-card{background:#1c2636;border:1px solid #2c3a52;border-radius:16px;padding:14px}
#ykgLobby .yl-card h3{margin:0 0 8px;font-size:13px;color:#9aa3b5;font-weight:700}
#ykgLobby .yl-members{display:flex;gap:6px;flex-wrap:wrap}
#ykgLobby .yl-members span{font-size:15px;padding:6px 12px;border-radius:99px;background:#0f141f}
#ykgLobby .yl-members span.me{outline:1px solid #f0b25a}
#ykgLobby .yl-members small{color:#9aa3b5;margin-left:4px;font-size:12px}
#ykgLobby .yl-rules{font-size:14px;line-height:1.6}
#ykgLobby .yl-settings button{font:inherit;font-weight:700;font-size:15px;border:0;border-radius:12px;padding:11px 8px;background:#2a3142;color:#e5e7eb}
#ykgLobby .yl-settings button.on{background:#f0b25a;color:#2a1a05}
#ykgLobby .yl-settings .yl-row{display:flex;gap:8px;flex-wrap:wrap}
#ykgLobby .yl-settings .yl-row>*{flex:1 1 0}
#ykgLobby .yl-settings .yl-sub{font-size:12px;color:#9aa3b5;margin-top:8px;line-height:1.5}
#ykgLobby .yl-bottom{flex:none;padding:12px 16px 16px;border-top:1px solid #2c3a52;max-width:520px;width:100%;margin:0 auto}
#ykgLobby .yl-main{display:block;width:100%;font:inherit;font-size:19px;font-weight:800;border:0;border-radius:14px;padding:16px;background:#f0b25a;color:#2a1a05}
#ykgLobby .yl-main:disabled{background:#2a3142;color:#9aa3b5}
#ykgLobby .yl-wait{text-align:center;font-size:16px;color:#9aa3b5;padding:16px 0}
#ykgLobby .yl-status{text-align:center;font-size:13px;color:#9aa3b5;margin-top:8px;min-height:1em}`;
    document.head.appendChild(st);
  }
  function defaultMembers() {
    if (isHost) return [{ name: party.name, tag: "ホスト", me: true }, ...[...guestConns.values()].map(g => ({ name: g.name, tag: g.spec ? "観戦" : "" }))];
    return lobbyState.members.map(m => ({ ...m, me: m.name === party.name }));
  }
  function renderLobby() {
    const o = lobbyState.opts; if (!o) return;
    if (!document.body) { addEventListener("DOMContentLoaded", renderLobby, { once: true }); return; }
    lobbyCss();
    let el = lobbyState.el;
    if (!el) {
      el = lobbyState.el = document.createElement("div"); el.id = "ykgLobby";
      el.innerHTML = `<div class="yl-top"><button class="yl-back">← 一覧</button><div class="yl-title"></div><div class="yl-code">パーティ<b></b></div></div>
        <div class="yl-body"><div class="yl-card"><h3>参加者</h3><div class="yl-members"></div></div>
          <div class="yl-card yl-rulescard"><h3>遊び方</h3><div class="yl-rules"></div></div>
          <div class="yl-card yl-setcard"><h3>設定</h3><div class="yl-settings"></div></div></div>
        <div class="yl-bottom"><div class="yl-act"></div><div class="yl-status"></div></div>`;
      el.querySelector(".yl-back").onclick = () => {
        if (!isHost || confirm("ゲーム一覧へ戻りますか？（みんなも一覧へ戻ります）")) window.ykgToGames();
      };
      document.body.appendChild(el);
    }
    el.querySelector(".yl-title").textContent = o.title || document.title.split(/[｜|]| - /)[0].trim() || document.title;
    el.querySelector(".yl-code b").textContent = party.code;
    const mem = o.members || defaultMembers();
    el.querySelector(".yl-members").innerHTML = mem.map(m => `<span class="${m.me ? "me" : ""}">${esc(m.name)}${m.tag ? `<small>${esc(m.tag)}</small>` : ""}</span>`).join("") || `<span>${esc(party.name)}</span>`;
    el.querySelector(".yl-rulescard").style.display = o.rules ? "" : "none";
    el.querySelector(".yl-rules").innerHTML = o.rules ? esc(o.rules).replace(/\n/g, "<br>") : "";
    const set = el.querySelector(".yl-settings");
    el.querySelector(".yl-setcard").style.display = o.settings ? "" : "none";
    if (o.settings instanceof HTMLElement) { if (set.firstChild !== o.settings) { set.innerHTML = ""; set.appendChild(o.settings); } }
    else set.innerHTML = o.settings || "";
    const act = el.querySelector(".yl-act");
    if (o.button) {
      let b = act.querySelector(".yl-main");
      if (!b) { act.innerHTML = `<button class="yl-main"></button>`; b = act.querySelector(".yl-main"); }
      b.textContent = o.button.label; b.disabled = !!o.button.disabled;
      b.onclick = () => { if (!b.disabled && o.button.onClick) o.button.onClick(); };
    } else act.innerHTML = `<div class="yl-wait">${esc(o.wait || "ホストがスタートするのを待っています…")}</div>`;
    el.querySelector(".yl-status").textContent = o.status || "";
    el.style.display = "flex";
  }
  window.ykgLobby = {
    get active() { return !!lobbyState.opts; },
    open(opts) {
      if (!isHost && lobbyState.remoteStarted) return;   // ホストがもう始めている（途中から来た人）
      lobbyState.opts = Object.assign({}, opts || {});
      if (isHost && lobbyState.started) { lobbyState.started = false; toGuests({ t: "members", list: defaultMembers(), started: false }); }
      renderLobby();
    },
    update(opts) { if (!lobbyState.opts) return; Object.assign(lobbyState.opts, opts || {}); renderLobby(); },
    close() { lobbyState.opts = null; if (lobbyState.el) lobbyState.el.style.display = "none"; },
    // ホスト: 自分の画面を閉じて、ゲストの待ち合わせ画面も閉じる（ゲームの通信で「始まった」を送らないゲーム用）
    closeAll() { this.close(); if (isHost) { lobbyState.started = true; toGuests({ t: "lobby-close" }); } },
  };
  function sendMembers() { if (isHost) { toGuests({ t: "members", list: defaultMembers().map(m => ({ name: m.name, tag: m.tag })), started: lobbyState.started }); if (lobbyState.opts && !lobbyState.opts.members) renderLobby(); } }

  if (typeof Peer !== "function") return;
  // 2026-11-09: オフライン（または ?offline=1 で試すとき）は、つなぎに行かない
  if (!navigator.onLine || /[?&]offline=1/.test(location.search)) return;

  // ---------- 2. ホスト: 待ち受け ----------
  if (isHost) {
    let tries = 0;
    const open = () => {
      if (leaving) return;
      peer = new Peer(ID);
      peer.on("connection", conn => {
        conn.on("data", m => {
          if (!m) return;
          if (m.t === "hi") {   // ゲーム一覧のゲスト（遅れてきた人）
            try { conn.send({ t: "go", game }); } catch (e) {}
            setTimeout(() => { try { conn.close(); } catch (e) {} }, 1500);
          } else if (m.t === "where") {   // ゲームの中のゲスト
            guestConns.set(conn, { name: String(m.name || "ゲスト").slice(0, 12), spec: !!m.spec });
            try { conn.send({ t: "at", game, started: lobbyState.started }); } catch (e) {}
            sendMembers();
          }
        });
        conn.on("close", () => { if (guestConns.delete(conn)) sendMembers(); });
      });
      peer.on("error", e => {
        if (e.type === "unavailable-id" && ++tries < 90) {   // ゲーム一覧の前の接続がまだ残っている: 空くのを待つ
          try { peer.destroy(); } catch (x) {}
          setTimeout(open, 1000);
        }
      });
    };
    setTimeout(open, 200);
    return;
  }

  // ---------- 3. ゲスト: ホストの待ち受けにつながっておく ----------
  let tries = 0, conn = null;
  const newPeer = () => {
    try { peer && peer.destroy(); } catch (e) {}
    peer = new Peer();
    peer.on("open", connect);
    peer.on("error", () => {});   // 見つからないときは下の時間切れでつなぎ直す
  };
  function connect() {
    if (leaving || !peer || peer.destroyed) return;
    const c = conn = peer.connect(ID, { reliable: true });
    setTimeout(() => {
      if (conn !== c || c.open || leaving) return;
      try { c.close(); } catch (e) {}
      if (++tries % 3 === 0) newPeer(); else connect();
    }, 2500);
    c.on("open", () => { c.opened = true; tries = 0; c.send({ t: "where", name: party.name, spec: !!party.spec }); });
    c.on("data", m => {
      if (!m) return;
      if (m.t === "back") window.ykgToGames();
      else if (m.t === "at") {
        if (m.list && m.game === game) {   // ホストがまだゲーム一覧にいて、このゲームへ移るところ: 少し待ってつなぎ直す
          conn = null; try { c.close(); } catch (e) {}
          setTimeout(() => { if (!conn && !leaving) connect(); }, 1500);
        }
        else if (!m.game) window.ykgToGames();
        else if (m.game !== game) goGame(m.game);
        else if (m.started) { lobbyState.remoteStarted = true; window.ykgLobby.close(); }
      }
      else if (m.t === "go" && m.game !== game) goGame(m.game);
      else if (m.t === "members") {
        lobbyState.members = m.list || [];
        if (m.started === false) lobbyState.remoteStarted = false;
        if (lobbyState.opts && !lobbyState.opts.members) renderLobby();
      }
      else if (m.t === "lobby-close") { lobbyState.remoteStarted = true; window.ykgLobby.close(); }
    });
    // つながったあとで切れた = ホストがゲームのページを離れた
    c.on("close", () => { if (conn === c && c.opened && !leaving) window.ykgToGames(); });
  }
  setTimeout(newPeer, 1200);
})();
