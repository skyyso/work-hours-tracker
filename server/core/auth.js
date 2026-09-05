// 认证：只用 Web Crypto（globalThis.crypto.subtle）
// 这样同一份代码在 Node 22 与 Cloudflare Workers 上都能跑，不引入任何 npm 依赖。

const enc = new TextEncoder();

export const DEFAULT_PW_ITER = 100000;
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 天

function toHex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

function fromHex(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

/** PBKDF2-SHA256 派生 32 字节，返回 hex */
export async function derive(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: fromHex(saltHex), iterations, hash: 'SHA-256' },
    key,
    256
  );
  return toHex(bits);
}

export async function hashPassword(password, iterations = DEFAULT_PW_ITER) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  const hash = await derive(password, salt, iterations);
  return { pwHash: hash, pwSalt: salt, pwIter: iterations };
}

/** 定长比较，避免按字符提前返回造成的时序泄漏 */
export function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, user) {
  const hash = await derive(password, user.pw_salt, user.pw_iter);
  return safeEqualHex(hash, user.pw_hash);
}

/** 会话令牌：明文只回给客户端一次，库里只存 SHA-256，泄库也换不出可用 token */
export function newToken() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

export async function hashToken(token) {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(token)));
}

export function bearerFrom(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+([A-Za-z0-9._-]+)$/.exec(h.trim());
  return m ? m[1] : null;
}
