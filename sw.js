// オフラインで動かすため、アプリ一式を最初に保存しておく。
// ファイルを更新したら VERSION を上げると、スマホ側も新しいものに入れ替わる。
const VERSION = "v1.1.0";
const FILES = [
  "./", "index.html", "style.css", "app.js", "parser.js", "manifest.webmanifest",
  "icons/icon-192.png", "icons/icon-512.png",
  "vendor/tesseract.min.js", "vendor/worker.min.js",
  "vendor/tesseract-core-simd-lstm.wasm.js", "vendor/tesseract-core-lstm.wasm.js",
  "vendor/jpn.traineddata.gz",
];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request)));
});
