// Expense Manager 離線開啟（Service Worker）
// - 網頁本身：有網路就抓最新版（不吃 GitHub 的 10 分鐘快取）並存一份；沒網路或 4 秒內沒回應 → 用手機裡存的那份
// - Chart.js、字型：存一份，沒網路也能顯示圖表
// - Google Apps Script（讀寫雲端資料）：完全不經過這裡，照舊直接連線
const CACHE = 'em-offline-v1';
const PAGE_TIMEOUT = 4000;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (/(^|\.)script\.google(usercontent)?\.com$/.test(url.hostname)) return;
  if (url.origin === self.location.origin) { e.respondWith(pageFirst(req, url)); return; }
  if (url.hostname === 'cdnjs.cloudflare.com' || /(^|\.)(fonts\.googleapis|fonts\.gstatic)\.com$/.test(url.hostname)) e.respondWith(cacheFirst(req));
});

// 網頁：網路優先，存一份；網路失敗或太慢就用存的
async function pageFirst(req, url) {
  const cache = await caches.open(CACHE);
  const key = url.origin + url.pathname;            // 不管 ?後面的參數，同一頁只存一份
  const net = fetch(url.href, { cache: 'no-store' }).then(res => {
    if (res && res.ok) cache.put(key, res.clone());
    return res;
  });
  net.catch(() => {});                              // 背景更新失敗不用報錯
  const saved = await cache.match(key);
  if (!saved) return net;                           // 第一次：只能等網路
  const timer = new Promise(r => setTimeout(() => r(null), PAGE_TIMEOUT));
  try {
    const res = await Promise.race([net, timer]);
    return res && res.ok ? res : saved;
  } catch (err) {
    return saved;                                   // 沒網路
  }
}

// Chart.js、字型：有存就用存的，沒有才上網抓並存起來
async function cacheFirst(req) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
  return res;
}
