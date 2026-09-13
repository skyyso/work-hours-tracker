// 生成 PWA 图标：复用 index.html 内联 favicon 的同一套图形语言（靛蓝圆角方块 + 时钟指针）。
// 用 Chromium 渲染 SVG 截图（omitBackground 保住透明圆角），再用 PIL 缩放出各尺寸。
// 一次性工具：图标改版时重跑 png/gen_icons.js 即可。
const puppeteer = require('/root/.openclaw/workspace/web_tasks/node_modules/puppeteer');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'icons');

// any：圆角方块，四角透明（浏览器/桌面场景显示）
const svgAny = (s) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${s}" height="${s}">
  <rect width="32" height="32" rx="8" fill="#4F46E5"/>
  <path d="M16 8v8l5 3" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

// maskable：满幅无圆角（由系统裁切），图形缩进 80% 安全区
const svgMaskable = (s) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${s}" height="${s}">
  <rect width="32" height="32" fill="#4F46E5"/>
  <g transform="translate(3.2 3.2) scale(0.8)">
    <path d="M16 8v8l5 3" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
  </g>
</svg>`;

// apple-touch-icon：满幅无圆角（iOS 自行加圆角）
const svgApple = (s) => `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${s}" height="${s}">
  <rect width="32" height="32" fill="#4F46E5"/>
  <path d="M16 8v8l5 3" stroke="white" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
</svg>`;

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium', headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
  });
  const page = await browser.newPage();

  async function shoot(svg, width, height, file) {
    await page.setViewport({ width, height });
    await page.setContent(`<style>*{margin:0;padding:0}svg{display:block}</style>${svg}`);
    await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width, height } });
  }

  await shoot(svgAny(512), 512, 512, path.join(OUT, 'icon-512.png'));
  await shoot(svgMaskable(512), 512, 512, path.join(OUT, 'icon-maskable-512.png'));
  await shoot(svgApple(180), 180, 180, path.join(OUT, 'apple-touch-icon.png'));
  await browser.close();

  // 高分辨率原图就位，小尺寸用 PIL Lanczos 缩（比再截一轮更快更稳）
  const { execSync } = require('child_process');
  execSync(`python3 - <<'PY'
from PIL import Image
import os
OUT = ${JSON.stringify(OUT)}
Image.open(os.path.join(OUT, 'icon-512.png')).resize((192,192), Image.LANCZOS).save(os.path.join(OUT, 'icon-192.png'), optimize=True)
Image.open(os.path.join(OUT, 'icon-maskable-512.png')).resize((192,192), Image.LANCZOS).save(os.path.join(OUT, 'icon-maskable-192.png'), optimize=True)
print('icons done')
PY`, { stdio: 'inherit' });

  for (const f of fs.readdirSync(OUT)) {
    const st = fs.statSync(path.join(OUT, f));
    console.log(f, st.size, 'bytes');
  }
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
