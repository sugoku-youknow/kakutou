// you know games（ミニゲーム集。もとはシールドファイト）のサービスワーカー。中のゲームもこれ 1 つで受け持つ。
// 2026-11-09: オフラインでも開けるように、ファイルを保存（キャッシュ）するようにした。
//   - このサイトのファイル（ページ・js・画像など）: いつもネットから新しい版を取り寄せ（index.html を更新すればすぐ反映）、
//     取れたら保存しておく。ネットにつながらないときだけ、保存しておいた分を使う。
//   - 外のライブラリ（three.js・PeerJS・Matter.js。URL に版が入っていて中身が変わらない）: 保存した分を先に使う。
//   - PeerJS の中継サーバーとの通信などには手を出さない。
// ページ本体は、ブラウザが保存している分（GitHub Pages は 10 分）も使わず、毎回サーバーに新しい版がないか確かめる（2026-10-18）
const CACHE = "ykg-v1";
const CDN_HOSTS = ["cdn.jsdelivr.net", "unpkg.com", "cdnjs.cloudflare.com"];
// 入れたときに先に保存しておくもの（取れなかったものは飛ばす。あとで開いたときにも保存される）
const PRE = [
  "./", "index.html", "manifest.json", "party-beacon.js?v=6", "ykg-sfx.js?v=1", "icon-192.png?v=3", "apple-touch-icon.png?v=3",
  "shieldfight/", "shieldfight/icon.png", "jenga/", "tameru/", "shougi/", "soinsu/", "kaitaku/",
  "gomu/", "gomu/style.css", "gomu/js/main.js", "gomu/js/game.js", "gomu/js/board.js", "gomu/js/network.js", "gomu/js/physics.js", "gomu/js/cpu.js",
  "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "https://cdn.jsdelivr.net/npm/@dimforge/rapier3d-compat@0.12.0/rapier.es.js",
  "https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js",
  "https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/matter-js/0.19.0/matter.min.js",
];
self.addEventListener("install", e => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then(c => Promise.allSettled(PRE.map(u =>
    fetch(new Request(u, u.startsWith("http") ? { mode: "cors" } : { cache: "no-cache" })).then(r => { if (r.ok) return Promise.resolve(unwrap(r)).then(x => c.put(u, x)); })))));
});
self.addEventListener("activate", e => e.waitUntil(
  caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())));

// 転送（例: /リポジトリ名 → /リポジトリ名/）を経た応答をそのまま返すと、Safari がページを開けないので、中身だけの応答に作り直す
function unwrap(r) {
  if (!r.redirected) return r;
  return r.blob().then(b => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers }));
}
const save = (req, r) => { if (r && r.ok && r.type !== "opaque") { const cp = r.clone(); caches.open(CACHE).then(c => c.put(req, cp)).catch(() => {}); } return r; };
const fromCache = req => caches.match(req).then(r => r || caches.match(req, { ignoreSearch: true }));

self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET") return;
  if (url.origin !== self.location.origin) {
    if (!CDN_HOSTS.includes(url.hostname)) return;   // PeerJS の中継サーバーなど: 手を出さない
    e.respondWith(caches.match(req.url).then(hit => hit || fetch(req.url, { mode: "cors", credentials: "omit" }).then(r => save(req.url, r))));
    return;
  }
  const page = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  const net = page ? fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(unwrap) : fetch(req.url, { cache: "no-cache", credentials: "same-origin" });   // js・css も毎回新しい版を確かめる（ゴム弾きの js が古いまま残ったので）
  e.respondWith(net.then(r => save(req, r)).catch(() => fromCache(req).then(hit => hit || (page ? fromCache(new Request(url.pathname)) : null))
    .then(hit => hit || Response.error())));
});
