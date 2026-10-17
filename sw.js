// シールドファイトのサービスワーカー。
// Chrome が「アプリとしてインストールできる」と判断するための最小限のもの。
// ファイルは保存（キャッシュ）せず、いつもネットから取り寄せるので、index.html を更新すればすぐ新しい版になる（オフラインでは動かない）。
// ページ本体（index.html）は、ブラウザが保存している分（GitHub Pages は 10 分）も使わず、毎回サーバーに新しい版がないか確かめる（2026-10-18）
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== self.location.origin) return;   // ほかのサイト（PeerJS の配布元など）への通信には手を出さない
  const page = req.mode === "navigate" || url.pathname.endsWith("/") || url.pathname.endsWith(".html");
  if (!page) { e.respondWith(fetch(req)); return; }
  e.respondWith(fetch(req.url, { cache: "no-cache", credentials: "same-origin" }).then(r => {
    if (!r.redirected) return r;
    // 転送（例: /リポジトリ名 → /リポジトリ名/）を経た応答をそのまま返すと、Safari がページを開けないので、中身だけの応答に作り直す
    return r.blob().then(b => new Response(b, { status: r.status, statusText: r.statusText, headers: r.headers }));
  }).catch(() => fetch(req)));
});
