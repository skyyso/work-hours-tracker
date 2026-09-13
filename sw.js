/**
 * 工时薪酬助手 — Service Worker
 *
 * 职责（刻意收得很窄）：
 *   1. 预缓存页面骨架（index.html / sync.js / payroll.js / vendor 两件 / manifest / 图标），
 *      保证离线或服务器彻底挂掉时页面能完整启动。
 *   2. 导航请求走 network-first + 离线兜底 index.html：在线时永远拿最新版，
 *      离线时用预缓存的骨架（本地记账照常，数据在 localStorage，与 SW 无关）。
 *   3. 静态资源 network-first：在线优先最新（no-cache 本来就要求「用前先问」），
 *      网络失败才回缓存 —— SW 不改变现有缓存策略，只补「彻底断网」这一层。
 *   4. /api/* 与 /mcp* 一律不碰：同步引擎自己有超时与 offline 处理，
 *      SW 绝不缓存 API 响应，避免「读到旧数据以为同步成功」的假象。
 *
 * 版本升级：静态资源 no-cache+ETag，导航每次都回源，新 index.html 引用的
 * vendor ?v= 指纹变化会触发重下，PRECACHE 键值同步更新即可。旧缓存条目
 * activate 时统一清理，不做遗留兜底。
 */
const VERSION = 'v3';
const PRECACHE = `wht-precache-${VERSION}`;
const RUNTIME = `wht-runtime-${VERSION}`;

// 页面骨架：缺一个离线就是白屏，全部预缓存。
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/sync.js',
  '/shared/payroll.js',
  '/vendor/vue.global.prod.js',
  '/vendor/tailwind.css',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable-192.png',
  '/icons/icon-maskable-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      // 骨架里任何一个取不到就放弃安装：宁可没有 SW 也不能装出半个能用的
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== PRECACHE && k !== RUNTIME)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

/** network-first：先在线取，失败回运行时缓存，再失败回预缓存。 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(request);
    if (res && res.ok) cache.put(request, res.clone());
    return res;
  } catch (e) {
    // ignoreSearch：离线时 vendor 实际请求带 ?v= 指纹，预缓存里是不带指纹的裸路径；
    // 不吞掉查询串就永远匹配不上，冷离线直接白屏。指纹内容不一致的风险可接受（离线本来就拿不到新版）。
    const cached = await cache.match(request, { ignoreSearch: true });
    if (cached) return cached;
    // 导航请求最终兜底：预缓存的 index.html（ignoreSearch 吞掉 ?source=pwa 等查询）
    const pre = await caches.open(PRECACHE);
    const fallback = await pre.match('/index.html', { ignoreSearch: true });
    if (fallback) return fallback;
    throw e;
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 只管同源 GET；跨域与 /api/*、/mcp/* 直接放行给网络
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/mcp' || url.pathname.startsWith('/mcp/')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(networkFirst(event.request, RUNTIME));
    return;
  }

  event.respondWith(networkFirst(event.request, RUNTIME));
});