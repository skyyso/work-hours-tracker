// VPS 本机入口：一个进程同时提供静态页面与 /api/*
//
// 为什么不用 express/hono：core/api.js 收发的是标准 Request/Response，
// Node 22 原生就有，加依赖只会让 CF Workers 那边多一层不必要的适配。
//
// 环境变量：
//   PORT        监听端口（默认 9523，避开现有的 9522 静态服务）
//   HOST        监听地址（默认 0.0.0.0；已有登录鉴权，但仍建议配反代 + HTTPS）
//   DB_PATH     SQLite 文件（默认 <server>/data/work-hours.db）
//   STATIC_DIR  静态目录（默认项目根，即 index.html 所在处）
//   ALLOW_REGISTER=1  开放注册（默认只允许「库里还没有用户」时注册首个账号）
//   ACCESS_LOG  访问日志文件（默认 <server>/data/access.log；设 off 关闭）

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { mkdirSync, createWriteStream, statSync, renameSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, brotliCompress, constants as zlibConstants } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, normalize, extname } from 'node:path';
import { SqliteStore } from './adapters/sqlite-node.js';
import { handleApi } from './core/api.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT || 9523);
const HOST = process.env.HOST || '0.0.0.0';
const DB_PATH = process.env.DB_PATH || join(__dirname, 'data', 'work-hours.db');
const STATIC_DIR = resolve(process.env.STATIC_DIR || join(__dirname, '..'));
const ALLOW_REGISTER = process.env.ALLOW_REGISTER === '1';
const ACCESS_LOG = process.env.ACCESS_LOG === 'off'
  ? null
  : resolve(process.env.ACCESS_LOG || join(__dirname, 'data', 'access.log'));

mkdirSync(dirname(DB_PATH), { recursive: true });
const store = new SqliteStore(DB_PATH);

// ===== 访问日志 =====
// 存在的理由很具体：出现过「页面到了、167KB 的 vue.global.prod.js 没到」这类单请求失败，
// 服务端却完全查不到那次请求，只能靠猜。记下状态码与实发字节数，下次同类问题可直接对账：
// 有记录且 bytes 完整 → 问题在客户端/链路；没记录 → 请求根本没到服务器。
// 只记这一台自用服务需要的最小字段，不记 cookie / Authorization / 请求体。
const LOG_MAX_BYTES = 8 * 1024 * 1024; // 超过就滚动一次，避免无人看管长成巨型文件
let logStream = null;

function openLog() {
  if (!ACCESS_LOG) return;
  mkdirSync(dirname(ACCESS_LOG), { recursive: true });
  try {
    if (statSync(ACCESS_LOG).size > LOG_MAX_BYTES) renameSync(ACCESS_LOG, ACCESS_LOG + '.1');
  } catch { /* 文件不存在，正常 */ }
  logStream = createWriteStream(ACCESS_LOG, { flags: 'a' });
  // 日志写不动绝不能拖垮服务，出错就退化成「不记日志」继续跑。
  logStream.on('error', e => {
    console.error('[access-log] 写入失败，已停用日志：', e.message);
    logStream = null;
  });
}
openLog();

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  return req.socket.remoteAddress || '-';
}

/**
 * 记一条访问。
 * status 用 '-' 表示连响应头都没发出去（客户端中途断开时会这样）。
 * sent 是本次响应实际写出的字节数（含响应头，所以比 want 大几百字节是正常的），want 是 body 应发字节数。
 * sent 明显小于 want 就是传输被截断——这正是 167KB 的 Vue 只到一半那类问题要抓的证据。
 * @param {import('node:net').Socket|null} sock 开头就存下的 socket 引用：res.socket 在 close 时已经置空，现场取不到。
 * @param {number} baseline 该 socket 在本次请求前已写字节数；keep-alive 下一条连接跑多个请求，不减就会累加。
 */
function writeAccess(req, res, startedAt, sock, baseline) {
  if (!logStream) return;
  const ms = Date.now() - startedAt;
  const status = res.headersSent ? res.statusCode : '-';
  const sent = sock ? Math.max(0, sock.bytesWritten - baseline) : 0;
  // 不能用 res.getHeader('content-length')：经 writeHead(status, obj) 设的头不进可查询的头集合，
  // 读出来永远是 undefined（实测过，最初写成那样日志里全是 want=-）。改由写响应的地方直接标上。
  const want = res.wantBytes ?? '-';
  const ua = String(req.headers['user-agent'] || '-').replace(/["\n\r]/g, ' ').slice(0, 200);
  const line = [
    new Date().toISOString(),
    clientIp(req),
    req.method,
    (req.url || '-').slice(0, 300),
    status,
    `sent=${sent}`,
    `want=${want}`,
    ms + 'ms',
    res.writableFinished ? 'done' : 'aborted',
    '"' + ua + '"'
  ].join(' ');
  logStream.write(line + '\n');
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json'
};

// 静态目录里混着源码、数据库、备份和调试产物，逐类挡掉。
// vendor/ 是页面真实依赖（tailwind.css / vue.global.prod.js），不能挡。
// shared/ 同样不能挡：payroll.js 是前端要 <script> 引的薪酬模块。
// .build/ 是构建时工具链（带 node_modules），跑时用不到，必须挡。
// test/ 与 tools/ 是测试网与基准生成器，只在开发机跑；basline JSON 里含全部场景明细，
//   发到公网既没用也多一份暴露面（挂上测试层时实测这几个路径都是 200，逐个堵掉）。
// package.json 会把脚本名与内部路径抖出去，一并挡。
// 注意 .db 后面可能跟时间戳（回收站里的文件），所以不能只匹配结尾。
const BLOCKED = /(^|\/)(server|\.trash|\.build|\.icons|design|png|test|tools|node_modules|\.git)(\/|$)|\.bak(\.|$)|\.db(\.|-|$)|\.sqlite|\.sql$|^\/verify_.*\.js$|^\/package(-lock)?\.json$/i;

// ===== 缓存策略 =====
// 起因：静态文件原来一律发 no-cache，于是每次开页面都要在移动网络上重下
// index.html(132KB) + vue.global.prod.js(164KB) + tailwind.css(23KB) ≈ 320KB。
// 访问日志里手机端每次实传约 497ms，本机 0–1ms。那 497ms 就是失败窗口：链路一抖，
// Vue 没到，页面直接掉进 boot-fail 卡片。少传一遍就是少一次失败机会。
//
// 分两档：
//   vendor/*  内容不变就永远别再问 → 一年期 immutable。
//             失效靠 URL 上的内容指纹（?v=<hash>），发 index.html 时由服务端注入。
//             不手写版本号：手写迟早会忘，忘了就是用户抱着旧 CSS 看错版式，比慢更难查。
//             文件一变指纹就变，换来的新 URL 天然是一次 cache miss，升级什么都不用改。
//   其余      仍是 no-cache，但带上 ETag。
//             no-cache 不等于不缓存，它只要求「用前先问一次」，正好配 ETag：
//             内容没变就回 304 空响应，index.html 这 132KB 由此变成几百字节。
const VENDOR_FILES = ['vendor/tailwind.css', 'vendor/vue.global.prod.js'];
const VENDOR_SET = new Set(VENDOR_FILES.map(p => '/' + p));
const IMMUTABLE = 'public, max-age=31536000, immutable';

// ===== 压缩 =====
// 这是本页面加载失败的真正大头，之前一直没做。
// 访问日志里 vue.global.prod.js 一笔 167KB 走了 488ms（约 340KB/s），整页裸传 346KB
// → 一秒多的传输窗口，链路在这期间抖一下 Vue 就到不了，页面掉进 boot-fail 卡片。
// 实测这几个文件 gzip 后合计约 108KB，只剩三分之一，窗口跟着缩到三分之一。
//
// 日志里那些 "1ms" 不能当成"很快就到了"：sent 统计的是写进内核 socket 缓冲区的字节，
// 小文件一次写完就返回，close 立刻触发。只有超出缓冲区的大文件才会阻塞到客户端收完，
// 488ms 才是真实的客户端下载耗时。所以别被小文件的 1ms 骗过去。
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|webmanifest)$/i;
const MIN_COMPRESS = 1024;   // 比这还小，压缩省的字节抵不上头部与 CPU 开销

const gzipAsync = promisify(gzip);
const brotliAsync = promisify(brotliCompress);

const sha12 = buf => createHash('sha256').update(buf).digest('hex').slice(0, 12);
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 只有「带 ?v= 的 vendor 请求」才发长缓存。
 * 裸 URL 一律 no-cache：页面里的引用都被打了指纹，不带 v 的地址页面根本不会用，
 * 给它一年期缓存是白担风险。
 */
function cacheFor(relPath, search) {
  return VENDOR_SET.has(relPath) && /[?&]v=/.test(search || '') ? IMMUTABLE : 'no-cache';
}

// 绝对路径 → { key, buf, fp, variants }。按 mtime+size 失效，压缩结果跟着一起缓存，
// 所以同一个文件只压一次。文件数是个位数，不需要 LRU。
const assets = new Map();

/**
 * 读一个静态资源，算内容指纹；index.html 额外把 vendor 引用改写成带指纹的形式。
 *
 * 正则里可选的 (\?v=…) 是为了幂等：源文件已经带指纹时不会叠成 ?v=a?v=b。
 * index.html 里 boot-fail 的 VUE_SRC 常量写的是同一个路径，会被一起替换 ——
 * 这正是需要的：重试按钮必须去撞和 <script> 完全相同的缓存条目，否则它「重试成功」
 * 之后 reload 用的还是那份坏副本，用户会卡在按钮点不好的死循环里。
 *
 * 指纹必须按改写后的内容算，不能按源文件的 mtime/size 算：
 * 升级 Vue 时 index.html 源文件一个字节都没动，但它该发出的 ?v= 变了。
 * 若 ETag 沿用源文件特征，浏览器会拿到 304、继续用旧 ?v=，新版本永远到不了用户手上。
 * 所以缓存键把两个 vendor 指纹一起算进去。
 * 某个 vendor 读不到就跳过它（fp=null），页面退化成原来的无指纹引用，
 * 而不是整页发不出去 —— 少一层缓存优化可以接受，白屏不行。
 */
async function loadAsset(abs, relPath, st0) {
  const st = st0 || await stat(abs);
  const isIndex = relPath === '/index.html';

  let fps = null;
  if (isIndex) {
    fps = [];
    for (const rel of VENDOR_FILES) {
      try { fps.push((await loadAsset(join(STATIC_DIR, rel), '/' + rel)).fp); }
      catch { fps.push(null); }
    }
  }

  const key = `${st.mtimeMs}:${st.size}` + (fps ? ':' + fps.join(',') : '');
  const hit = assets.get(abs);
  if (hit && hit.key === key) return hit;

  let buf = await readFile(abs);
  if (isIndex) {
    let html = buf.toString('utf8');
    VENDOR_FILES.forEach((rel, i) => {
      if (!fps[i]) return;
      html = html.replace(new RegExp(escapeRe(rel) + '(\\?v=[0-9a-f]+)?', 'g'), `${rel}?v=${fps[i]}`);
    });
    buf = Buffer.from(html, 'utf8');
  }

  const entry = { key, buf, fp: sha12(buf), variants: new Map() };
  assets.set(abs, entry);
  return entry;
}

/**
 * 取某个编码下的响应体。压缩一次就存住，之后同一编码直接复用。
 *
 * ETag 带上编码后缀：同一份内容的 gzip 与未压缩版本必须是不同的 ETag，
 * 否则中间缓存有机会把压缩正文配上未压缩的 ETag 发给不支持压缩的客户端。
 */
async function variantOf(entry, enc) {
  if (!enc) return { buf: entry.buf, etag: `"${entry.fp}"` };
  const hit = entry.variants.get(enc);
  if (hit) return hit;
  const buf = enc === 'br'
    ? await brotliAsync(entry.buf, {
        params: {
          [zlibConstants.BROTLI_PARAM_QUALITY]: 10,
          [zlibConstants.BROTLI_PARAM_SIZE_HINT]: entry.buf.length
        }
      })
    : await gzipAsync(entry.buf, { level: 9 });
  const v = { buf, etag: `"${entry.fp}-${enc}"` };
  entry.variants.set(enc, v);
  return v;
}

/** 按 Accept-Encoding 选编码。只压文本类；显式 q=0 视为不支持。 */
function pickEncoding(req, relPath) {
  if (!COMPRESSIBLE.test(relPath)) return null;
  const ae = String(req.headers['accept-encoding'] || '');
  const ok = name => new RegExp(`(^|,)\\s*${name}\\s*(;\\s*q=(?!0(\\.0*)?(,|$))[^,]*)?(,|$)`, 'i').test(ae);
  if (ok('br')) return 'br';
  if (ok('gzip')) return 'gzip';
  return null;
}

/** 比对 If-None-Match。有中间设备会把强 ETag 降级成 W/"…"，所以剥掉前缀再比。 */
function etagMatches(header, etag) {
  if (!header) return false;
  return header.split(',').some(t => t.trim().replace(/^W\//, '') === etag);
}

/** Node IncomingMessage → 标准 Request */
async function toRequest(req) {
  const url = `http://${req.headers.host || 'localhost'}${req.url}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) v.forEach(x => headers.append(k, x));
    else if (v !== undefined) headers.set(k, v);
  }
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  let body;
  if (hasBody) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 8 * 1024 * 1024) throw new Error('body too large');
      chunks.push(c);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body });
}

/** 标准 Response → Node ServerResponse */
async function sendResponse(res, response) {
  const headers = {};
  response.headers.forEach((v, k) => { headers[k] = v; });
  res.writeHead(response.status, headers);
  if (response.body) {
    const buf = Buffer.from(await response.arrayBuffer());
    res.wantBytes = buf.length;
    res.end(buf);
  } else res.end();
}

async function serveStatic(req, res, pathname, search) {
  // 防目录穿越：normalize 后必须仍在 STATIC_DIR 内
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const target = resolve(join(STATIC_DIR, normalize(rel)));
  if (!target.startsWith(STATIC_DIR)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }
  // 不对外暴露：服务端源码与数据库、历史备份、回收站、验证脚本。
  // 这些都不是页面资源，泄出去只有坏处（旧 python http.server 就把它们全发了）。
  const relPath = target.slice(STATIC_DIR.length).replace(/\\/g, '/');
  if (BLOCKED.test(relPath)) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('404 Not Found');
  }
  try {
    const st = await stat(target);
    if (st.isDirectory()) return serveStatic(req, res, join(rel, 'index.html'), search);

    const entry = await loadAsset(target, relPath, st);
    const enc = entry.buf.length >= MIN_COMPRESS ? pickEncoding(req, relPath) : null;
    const { buf, etag } = await variantOf(entry, enc);
    const cc = cacheFor(relPath, search);

    // Vary 只对可压缩类型有意义；对图片等加上只会白白降低中间缓存命中率
    const common = { etag, 'cache-control': cc };
    if (COMPRESSIBLE.test(relPath)) common.vary = 'accept-encoding';

    if (etagMatches(req.headers['if-none-match'], etag)) {
      res.wantBytes = 0;   // 日志里 want=0 即代表命中 304，没传正文
      res.writeHead(304, common);
      return res.end();
    }

    res.wantBytes = buf.length;
    res.writeHead(200, {
      'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
      'content-length': buf.length,
      ...(enc ? { 'content-encoding': enc } : {}),
      ...common
    });
    res.end(buf);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  }
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  // socket 必须现在存下：close 触发时 res.socket 已置空，到那时才读永远是 0。
  const sock = res.socket;
  const baseline = sock ? sock.bytesWritten : 0;
  // 挂 close 而不是 finish：finish 只在正常写完时触发，
  // 而「传到一半客户端断开」恰恰是要留证据的情况，close 两种都能覆盖。
  res.on('close', () => writeAccess(req, res, startedAt, sock, baseline));
  try {
    const u = new URL(req.url, 'http://x');
    if (u.pathname.startsWith('/api/')) {
      const response = await handleApi(await toRequest(req), store, { allowRegister: ALLOW_REGISTER });
      return await sendResponse(res, response);
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('405 Method Not Allowed');
    }
    await serveStatic(req, res, u.pathname, u.search);
  } catch (e) {
    console.error('[server]', e);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: false, error: '服务器内部错误' }));
  }
});

server.listen(PORT, HOST, async () => {
  const n = await store.countUsers();
  // 预热：首个请求不该为「第一次压缩」买单。这几个文件是每次开页面都要的。
  // 失败不影响启动，真有请求时会再压一次。
  const warm = ['/index.html', '/sync.js', ...VENDOR_FILES.map(p => '/' + p)];
  let warmed = 0;
  for (const rel of warm) {
    try {
      const entry = await loadAsset(join(STATIC_DIR, rel), rel);
      await variantOf(entry, 'br');
      await variantOf(entry, 'gzip');
      warmed++;
    } catch { /* 缺文件就跳过 */ }
  }
  console.log(`工时记账服务已启动  http://${HOST}:${PORT}`);
  console.log(`  数据库    ${DB_PATH}`);
  console.log(`  静态目录  ${STATIC_DIR}`);
  console.log(`  压缩预热  ${warmed}/${warm.length} 个资源（br + gzip）`);
  console.log(`  注册策略  ${ALLOW_REGISTER ? '开放注册' : (n === 0 ? '等待创建首个账号' : '已关闭（库中已有账号）')}`);
  console.log(`  现有用户  ${n}`);
  console.log(`  访问日志  ${ACCESS_LOG || '已关闭'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`\n收到 ${sig}，正在关闭…`);
    server.close(() => { store.close(); logStream?.end(); process.exit(0); });
  });
}
