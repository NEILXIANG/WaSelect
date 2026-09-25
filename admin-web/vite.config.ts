/**
 * 职责：admin-web 的 Vite 配置（F15 单元③）。
 *
 * @why `port: 5174 + strictPort`：Vite 默认 5173 已被 **checkout-static 的本地预览**占用
 *      （.env.example `CHECKOUT_BASE_URL=http://localhost:5173`，D-49 的短链第一跳）。
 *      两端同端口的表现是"后起的那个自动 +1"，于是哪天先起哪个，admin 就在哪个端口——
 *      而 server 的 CORS 白名单是**精确匹配**（http.ts，不支持通配），端口漂移 = 跨域全挂。
 *      strictPort 让"5174 被占"直接起不来（响亮失败），而不是悄悄换到 5175（静默失败）。
 *      端口值与 .env.example CORS_ORIGINS 的绑定有同源断言（design-token.unit.test.ts）。
 *
 * @limitation 没有配 dev 代理（`/api` → localhost:3000）：管理端与 API 不同域是**生产形态**
 *      （D21），dev 用代理会把跨域问题藏到上线那天才暴露。CORS 白名单从第一天就按真实拓扑配。
 */
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: { port: 5174, strictPort: true },
});
