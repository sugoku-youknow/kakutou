// シールドファイトのサービスワーカー。
// Chrome が「アプリとしてインストールできる」と判断するための最小限のもの。
// ファイルは保存（キャッシュ）せず、いつもネットから取り寄せるので、index.html を更新すればすぐ新しい版になる（オフラインでは動かない）。
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET" || new URL(e.request.url).origin !== self.location.origin) return;   // ほかのサイト（PeerJS の配布元など）への通信には手を出さない
  e.respondWith(fetch(e.request));
});
