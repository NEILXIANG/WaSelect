/**
 * 职责：admin-web 装配入口（F15 单元③）——挂载 React 根、引入 token 与页面样式。
 * 边界：只做装配；请求语义在 api/，页面结构在 App.tsx。
 *
 * @see vite.config.ts；docs/地基搭建清单.md F15
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
// tokens.css 是生成物（scripts/gen-admin-tokens.ts，predev/prebuild 自动重生成），勿手改
import './tokens.css';
import './app.css';

const container = document.getElementById('root');
if (container === null) {
  // index.html 里没有 #root = 骨架被改坏：响亮失败，不渲染一个"看起来正常"的半吊子页面
  throw new Error('index.html 缺少 #root 挂载点');
}
createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
