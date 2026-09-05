/** Tailwind 构建配置 —— 只在开发机跑，产物是 vendor/tailwind.css，运行时不需要它
 *  content 指向 index.html：JIT 扫描其中出现的 class 字面量，只生成用到的那些。
 *  已确认 index.html 里没有字符串拼接/模板字符串生成的 class，所以静态扫描是完备的。
 */
module.exports = {
  content: ['../index.html'],
  theme: {
    extend: {}
  },
  plugins: []
};
