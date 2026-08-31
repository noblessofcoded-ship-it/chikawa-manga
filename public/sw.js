/**
 * オフラインでも本棚が開けるようにするためのサービスワーカー。
 *
 * 扱うのは自分のオリジンのファイルだけ。Xの埋め込み（別オリジン）には
 * いっさい触らないので、漫画の画像がここにキャッシュされることはない。
 */

const VERSION = 'v1';
const SHELL = `shelf-shell-${VERSION}`;
const DATA = `shelf-data-${VERSION}`;

const SHELL_FILES = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './lib/chapters.js',
  './lib/postref.js',
  './lib/sort.js',
  './manifest.webmanifest',
  './icons/icon-180.png',
  './icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL)
      // 1つ欠けても全体が失敗しないように、個別に入れる
      .then((cache) => Promise.all(SHELL_FILES.map((f) => cache.add(f).catch(() => null))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== DATA).map((k) => caches.delete(k)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;   // Xの埋め込みなどは素通し
  if (url.pathname.includes('/api/')) return;        // サーバー版のAPIは触らない

  // 索引は新しさが大事なので、まずネットワーク。取れなければ手元の写しを返す。
  if (url.pathname.endsWith('.json')) {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(DATA).then((c) => c.put(request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(request).then((hit) => hit || Response.json({ episodes: [] }))),
    );
    return;
  }

  // 器のファイルは手元優先。裏で新しいものに差し替えておく。
  event.respondWith(
    caches.match(request).then((hit) => {
      const network = fetch(request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => hit);
      return hit || network;
    }),
  );
});
