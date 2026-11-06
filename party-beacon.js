// party-beacon.js（2026-11-06）
// パーティのホストがゲームの中にいるあいだ、ゲーム一覧と同じ「パーティの番号」（ykg-party-番号）でも待ち受ける。
// ゲストのゲーム一覧が遅れてつながってきたら（ホストがゲームを選んだときにまだつながっていなかった人）、
// 「いまこのゲームにいます」と伝えて、同じゲームへ来てもらう。これがないと、ホストだけがゲームへ移ってゲストが取り残される。
// 各ゲームのページで PeerJS のあとに読み込む。パーティのホストでないときは何もしない。
(function () {
  let party = null;
  try { party = JSON.parse(sessionStorage.getItem("ykg-party") || "null"); } catch (e) {}
  if (!party || party.role !== "host" || party.code == null || !/[?&]party=1/.test(location.search)) return;
  if (typeof Peer === "undefined") return;
  const game = location.pathname.replace(/\/(index\.html)?$/, "").split("/").pop() + "/";   // 例: "soinsu/"（ゲーム一覧から見た場所）
  let peer = null, tries = 0, stopped = false;
  function open() {
    if (stopped) return;
    peer = new Peer("ykg-party-" + party.code);
    peer.on("connection", conn => {
      conn.on("data", m => {
        if (m && m.t === "hi") { try { conn.send({ t: "go", game }); } catch (e) {} setTimeout(() => { try { conn.close(); } catch (e) {} }, 1500); }
      });
    });
    peer.on("disconnected", () => { try { if (!peer.destroyed) peer.reconnect(); } catch (e) {} });
    peer.on("error", e => {
      if (e.type === "unavailable-id" && ++tries < 60) {   // ゲーム一覧の前の接続がまだ残っている: 空くのを待つ
        try { peer.destroy(); } catch (x) {}
        setTimeout(open, 1500);
      }
    });
  }
  setTimeout(open, 300);
  addEventListener("pagehide", () => { stopped = true; try { peer && peer.destroy(); } catch (e) {} });
})();
