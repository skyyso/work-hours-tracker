// MCP 端点与管理 API 自测：同样直调 core，不起 HTTP 端口，跑得快也不占端口。
// 覆盖：未配置关闭、从零生成 Token、鉴权、JSON-RPC 全链路、DB 真开关即时生效、Token 轮换。
//
//   node --disable-warning=ExperimentalWarning test/mcp.test.js

import { handleMcp } from '../core/mcp.js';
import { handleApi } from '../core/api.js';
import { SqliteStore } from '../adapters/sqlite-node.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let pass = 0, fail = 0;
const tmp = mkdtempSync(join(tmpdir(), 'wht-mcp-test-'));
const store = new SqliteStore(join(tmp, 'test.db'));

function section(t) { console.log(`\n── ${t}`); }
function ok(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' → ' + extra : ''}`); }
}
function eq(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  ok(name, a === e, `实得 ${a}，应为 ${e}`);
}

// MCP：直接构造 JSON-RPC POST 请求
async function rpc(msg, token) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handleMcp(new Request('http://t/mcp', {
    method: 'POST', headers, body: JSON.stringify(msg)
  }), store, {});
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, body: json, text };
}

// 管理 API：与 api.test.js 同一套调用模式
let TOKEN = null;
async function call(method, path, body, token = TOKEN, opts = { allowRegister: true }) {
  const headers = { 'content-type': 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await handleApi(new Request('http://t' + path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body)
  }), store, opts);
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, body: json };
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } };

// ==========================================================
section('未配置时：整个端点关闭');
{
  let r = await rpc(INIT);
  eq('无 Token → 404', r.status, 404);
  ok('404 说明未配置', /未配置/.test(r.text), r.text);

  r = await handleMcp(new Request('http://t/mcp', { method: 'GET' }), store, {});
  eq('GET 无 Token 同样 404', r.status, 404);

  r = await call('GET', '/api/mcp/status');
  eq('管理 API 未登录 401', r.status, 401);
}

// ==========================================================
section('管理 API：从零生成 Token（注册 + 登录）');
{
  let r = await call('POST', '/api/register', { username: 'kory', password: 'kory-pass-123' });
  eq('注册首个用户 201', r.status, 201);
  r = await call('POST', '/api/login', { username: 'kory', password: 'kory-pass-123' });
  eq('登录 200', r.status, 200);
  TOKEN = r.body.token;

  r = await call('POST', '/api/mcp/token');
  eq('零配置生成 Token 200', r.status, 200);
  ok('返回明文 Token', typeof r.body.token === 'string' && r.body.token.length >= 32);
  ok('自动启用', r.body.enabled === true);
  globalThis.__T1 = r.body.token;

  r = await call('GET', '/api/mcp/status');
  eq('状态 200', r.status, 200);
  ok('configured=true', r.body.configured === true);
  ok('enabled=true', r.body.enabled === true);
  ok('Token 掩码化', typeof r.body.masked === 'string' && r.body.masked.includes('…'), JSON.stringify(r.body.masked));
  ok('掩码不是明文', r.body.masked !== globalThis.__T1);

  r = await call('GET', '/api/mcp/token');
  eq('取回明文一致', r.body && r.body.token, globalThis.__T1);

  r = await call('POST', '/api/mcp/enabled', { enabled: 'yes' });
  eq('非布尔 enabled 400', r.status, 400);
}

// ==========================================================
section('MCP 端点：鉴权与 JSON-RPC 全链路');
{
  let r = await rpc(INIT, 'wrong-token');
  eq('错 token 401', r.status, 401);

  r = await rpc(INIT, globalThis.__T1);
  eq('initialize 200', r.status, 200);
  eq('协议版本原样回', r.body && r.body.result && r.body.result.protocolVersion, '2025-06-18');

  const res = await handleMcp(new Request('http://t/mcp', {
    method: 'GET', headers: { authorization: `Bearer ${globalThis.__T1}` }
  }), store, {});
  eq('GET → 405（只收 POST）', res.status, 405);

  r = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, globalThis.__T1);
  eq('通知 → 202 空响应', r.status, 202);

  r = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, globalThis.__T1);
  ok('工具共 7 个', r.body && r.body.result && r.body.result.tools.length === 7,
    r.body && r.body.result ? String(r.body.result.tools.length) : 'no result');
  ok('含 get_month_summary / simulate_leave',
    r.body.result.tools.some(t => t.name === 'get_month_summary') &&
    r.body.result.tools.some(t => t.name === 'simulate_leave'));

  r = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_month_summary', arguments: { year: 2026, month: 9 } } }, globalThis.__T1);
  eq('tools/call 200', r.status, 200);
  ok('返回 text content', r.body.result && r.body.result.content && r.body.result.content[0].type === 'text');
  ok('structuredContent period 正确', r.body.result.structuredContent.period === '2026-09');

  r = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, globalThis.__T1);
  eq('未知工具 -32602', r.body && r.body.error && r.body.error.code, -32602);

  r = await rpc({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_month_summary', arguments: { year: 2026, month: 13 } } }, globalThis.__T1);
  eq('month 越界 -32602', r.body && r.body.error && r.body.error.code, -32602);

  r = await rpc({ jsonrpc: '2.0', id: 6, method: 'bogus/method' }, globalThis.__T1);
  eq('未知方法 -32601', r.body && r.body.error && r.body.error.code, -32601);
}

// ==========================================================
section('DB 真开关：即时生效无需重启');
{
  let r = await call('POST', '/api/mcp/enabled', { enabled: false });
  eq('关闭 200', r.status, 200);
  ok('返回 false', r.body.enabled === false);

  r = await rpc(INIT, globalThis.__T1);
  eq('关闭后 → 503', r.status, 503);
  ok('503 说明可重新启用', /重新开启|重新启用/.test(r.text), r.text);

  r = await call('POST', '/api/mcp/enabled', { enabled: true });
  eq('重新启用 200', r.status, 200);
  r = await rpc(INIT, globalThis.__T1);
  eq('恢复 200', r.status, 200);
}

// ==========================================================
section('Token 轮换：旧的立即失效');
{
  let r = await call('POST', '/api/mcp/token');
  ok('新 Token 与旧不同', r.body.token && r.body.token !== globalThis.__T1);
  globalThis.__T2 = r.body.token;

  r = await rpc(INIT, globalThis.__T1);
  eq('旧 token 401', r.status, 401);
  r = await rpc(INIT, globalThis.__T2);
  eq('新 token 200', r.status, 200);

  r = await call('GET', '/api/mcp/token');
  eq('取回明文是新 Token', r.body.token, globalThis.__T2);
}

// ==========================================================
section('多用户 MCP 隔离：不同 Token 独立绑定不同用户');
{
  // 注册第二个用户 user2
  let r = await call('POST', '/api/register', { username: 'alice', password: 'alice-pass-123' }, null, { allowRegister: true });
  eq('第二个用户注册 201', r.status, 201);
  r = await call('POST', '/api/login', { username: 'alice', password: 'alice-pass-123' }, null);
  eq('第二个用户登录 200', r.status, 200);
  const user2Token = r.body.token;

  // 用户2 推送自己的打卡数据（9/10 10小时）
  await call('POST', '/api/push', {
    records: {
      '2026-09-10': { status: 'work', shift_type: 'day', hours: 10 }
    }
  }, user2Token);

  // 用户1 推送自己的打卡数据（9/10 6小时）
  await call('POST', '/api/push', {
    records: {
      '2026-09-10': { status: 'work', shift_type: 'day', hours: 6 }
    }
  }, TOKEN);

  // 用户2 生成自己的 MCP Token
  r = await call('POST', '/api/mcp/token', undefined, user2Token);
  eq('用户2 生成 MCP Token 200', r.status, 200);
  const user2McpToken = r.body.token;
  ok('用户2 的 MCP Token 与用户1 不同', user2McpToken !== globalThis.__T2);

  // 用 用户1 的 MCP Token 查 9月总结
  const CALL_SUMMARY = {
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'get_month_summary', arguments: { year: 2026, month: 9 } }
  };
  const r1 = await rpc(CALL_SUMMARY, globalThis.__T2);
  eq('用户1 MCP 调用成功', r1.status, 200);
  eq('用户1 工时是 6h', r1.body.result.structuredContent.hours.total, 6);

  // 用 用户2 的 MCP Token 查 9月总结
  const r2 = await rpc(CALL_SUMMARY, user2McpToken);
  eq('用户2 MCP 调用支持成功', r2.status, 200);
  eq('用户2 工时是 10h', r2.body.result.structuredContent.hours.total, 10);
}

// ==========================================================
store.close();
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${'='.repeat(46)}`);
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
console.log('='.repeat(46));
process.exit(fail === 0 ? 0 : 1);