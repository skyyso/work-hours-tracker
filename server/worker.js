// Cloudflare Workers 入口
//
// 与 node-server.js 是同一套 core/api.js，只是换了存储适配器（D1）与静态资源方式。
// 部署前：
//   1. wrangler d1 create work-hours          # 拿到 database_id 填进 wrangler.toml
//   2. npm run cf:migrate                     # 建表
//   3. npm run cf:deploy
//
// 静态资源走 Workers Assets（wrangler.toml 里的 [assets]），
// 所以这里只处理 /api/*，其余交回 env.ASSETS。

import { handleApi } from './core/api.js';
import { D1Store } from './adapters/d1.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      if (!env.DB) {
        return new Response(
          JSON.stringify({ ok: false, error: 'D1 未绑定：请在 wrangler.toml 配置 [[d1_databases]] binding = "DB"' }),
          { status: 500, headers: { 'content-type': 'application/json; charset=utf-8' } }
        );
      }
      return handleApi(request, new D1Store(env.DB), {
        allowRegister: env.ALLOW_REGISTER === '1'
      });
    }

    // 静态资源：绑定了 Assets 就交给它，否则给个明确提示而不是 404 让人猜
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('静态资源未绑定（需在 wrangler.toml 配置 [assets]）', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }
};
