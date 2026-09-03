/* 生成物。scripts/build-web.js が毎ビルド書き出す（手で編集しない） */
const VERSION = '2026-09-03T00-39-36-107Z';
const CACHE = 'kakei-' + VERSION;
const ASSETS = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // addAll は1つでも失敗すると全部落ちる。1ファイルの取りこぼしで
    // オフライン対応そのものが無効になるのを避け、個別に入れる
    await Promise.all(ASSETS.map((u) => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

/*
 * ★ ネットワーク優先。
 *   家計データは index.html に同梱されており毎月まるごと書き換わる。
 *   キャッシュ優先にすると「更新したのに先月の数字が出る」という、
 *   このアプリで最もやってはいけない事故が起きる。
 *   通信が無いときだけキャッシュに落とし、オフラインでも開けるようにする。
 */
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  if (new URL(req.url).origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) (await caches.open(CACHE)).put(req, fresh.clone());
      return fresh;
    } catch (err) {
      const cached = await caches.match(req, { ignoreSearch: true });
      if (cached) return cached;
      // 「/」や「?x=1」付きで開かれても、入口のHTMLに寄せて必ず画面を出す
      if (req.mode === 'navigate') {
        const fallback = await caches.match('./index.html');
        if (fallback) return fallback;
      }
      throw err;
    }
  })());
});
