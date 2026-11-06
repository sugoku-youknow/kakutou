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

  let party = null;
  try { party = JSON.parse(sessionStorage.getItem("ykg-party") || "null"); } catch (e) {}
  const inParty = !!(party && party.code != null && /[?&]party=1/.test(location.search));
  if (!inParty) { window.ykgToGames = () => { location.href = "../"; }; return; }

  const isHost = party.role === "host";
  const game = location.pathname.replace(/\/(index\.html)?$/, "").split("/").pop() + "/";   // 例: "soinsu/"
  const ID = "ykg-party-" + party.code;
  const guestConns = new Set();   // ホスト: ゲームの中のゲストとのつながり
  let peer = null, leaving = false;

  function sendBack() { for (const c of guestConns) { try { c.send({ t: "back" }); } catch (e) {} } }
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

  if (typeof Peer !== "function") return;

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
            guestConns.add(conn);
            try { conn.send({ t: "at", game }); } catch (e) {}
          }
        });
        conn.on("close", () => guestConns.delete(conn));
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
    c.on("open", () => { c.opened = true; tries = 0; c.send({ t: "where" }); });
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
      }
      else if (m.t === "go" && m.game !== game) goGame(m.game);
    });
    // つながったあとで切れた = ホストがゲームのページを離れた
    c.on("close", () => { if (conn === c && c.opened && !leaving) window.ykgToGames(); });
  }
  setTimeout(newPeer, 1200);
})();
