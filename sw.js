// 오프라인 사용을 위한 서비스 워커 (빌드: 20261017T071314)
const CACHE = "quiz-20261017T071314";
const SHELL = ["./", "index.html", "style.css", "app.js", "srs.js", "stats.js", "store.js", "bank.json", "manifest.webmanifest", "icon-192.png"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.includes("/img/")) {
    // 문제 이미지: 한 번 본 것은 저장해 두고 다음부터는 저장본 사용
    e.respondWith(caches.open(CACHE).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const r = await fetch(e.request);
      if (r.ok) c.put(e.request, r.clone());
      return r;
    }));
    return;
  }
  // 화면·데이터: 인터넷이 되면 최신본, 안 되면 저장본
  e.respondWith(fetch(e.request).then((r) => {
    if (r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
    return r;
  }).catch(() => caches.match(e.request, { ignoreSearch: true })));
});
