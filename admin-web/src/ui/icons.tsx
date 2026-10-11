/**
 * 职责：管理端的线形图标（AJ-411）——侧栏九个页面 + 品牌标 + 退出，全部自绘内联 SVG。
 *
 * @why 自绘而不是图标字体 / Material Symbols：完全自研、零外部下载（不拉 CDN 字体，也不拷贝第三方图标文件）；
 *      九个图标用直线和圆弧就画得出，比引一整套图标库便宜。
 * @why `currentColor` + `aria-hidden`：颜色跟着所在按钮的状态走（选中 / 悬停）；
 *      图标只是装饰，旁边一定有文字（AJ-410：不让新手猜图标），读屏只读文字。
 * @limitation 24×24 网格、1.75 描边，是照 M3 图标的比例手画的近似形，不是官方图形。
 */
import type { ReactNode } from 'react';
import type { PageKey } from '../router.js';

function Svg({ children }: { children: ReactNode }): React.JSX.Element {
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

const NAV_PATHS: Record<PageKey, ReactNode> = {
  // 工作台：四宫格仪表
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="9" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="5" rx="1.5" />
      <rect x="13.5" y="11.5" width="7" height="9" rx="1.5" />
      <rect x="3.5" y="15.5" width="7" height="5" rx="1.5" />
    </>
  ),
  // 订单：单据 + 三行
  orders: (
    <>
      <path d="M6 3.5h12a1.5 1.5 0 0 1 1.5 1.5v15.5l-3-2-3 2-3-2-3 2-3-2V5A1.5 1.5 0 0 1 6 3.5Z" />
      <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4" />
    </>
  ),
  // 客户：人像
  customers: (
    <>
      <circle cx="12" cy="8.5" r="4" />
      <path d="M4.5 20.5c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5" />
    </>
  ),
  // 商品：盒子
  products: (
    <>
      <path d="M3.5 7.5 12 3.5l8.5 4v9L12 20.5l-8.5-4Z" />
      <path d="M3.5 7.5 12 11.5l8.5-4M12 11.5v9" />
    </>
  ),
  // 商品分类：四宫格（AJ-491）
  categories: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="7" rx="1.5" />
      <rect x="4" y="13" width="7" height="7" rx="1.5" />
      <rect x="13" y="13" width="7" height="7" rx="1.5" />
    </>
  ),
  // 运营配置：滑杆
  ops: (
    <>
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2" />
      <circle cx="9" cy="17" r="2" />
    </>
  ),
  // 首页 Banner：图片框
  banners: (
    <>
      <rect x="3.5" y="5.5" width="17" height="13" rx="2" />
      <path d="m3.5 15.5 4.5-4 4 3.5 3-2.5 5.5 4.5" />
      <circle cx="15.5" cy="9.5" r="1.25" />
    </>
  ),
  // 风控：盾牌
  risk: (
    <>
      <path d="M12 3.5 19.5 6v5.5c0 4.5-3.2 7.7-7.5 9-4.3-1.3-7.5-4.5-7.5-9V6Z" />
      <path d="m9 12 2.2 2.2L15.5 10" />
    </>
  ),
  // 运营日志：时钟
  opslog: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  // 设置：齿轮（八齿的简化形）
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.5v2.5M12 18v2.5M3.5 12H6M18 12h2.5M6 6l1.8 1.8M16.2 16.2 18 18M6 18l1.8-1.8M16.2 7.8 18 6" />
    </>
  ),
};

/** 侧栏页面图标。 */
export function NavIcon({ page }: { page: PageKey }): React.JSX.Element {
  return <Svg>{NAV_PATHS[page]}</Svg>;
}

/** 退出登录：门 + 向外箭头。 */
export function LogoutIcon(): React.JSX.Element {
  return (
    <Svg>
      <path d="M13.5 4.5h-7a1.5 1.5 0 0 0-1.5 1.5v12a1.5 1.5 0 0 0 1.5 1.5h7" />
      <path d="M10.5 12h10M17 8.5l3.5 3.5-3.5 3.5" />
    </Svg>
  );
}

/** 品牌标：圆角方块里一道折线（纯装饰，品牌名仍是文字）。 */
export function BrandMark(): React.JSX.Element {
  return (
    <Svg>
      <rect x="3" y="3" width="18" height="18" rx="5" />
      <path d="m7 9 2.5 7L12 10l2.5 6L17 9" />
    </Svg>
  );
}
