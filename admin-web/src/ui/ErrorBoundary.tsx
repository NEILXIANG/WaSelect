/**
 * 职责：页面级错误边界（AJ-421）——当前页渲染出错时只把**这一块**换成说明，侧栏照常可用；同时上报。
 *
 * @why 包在"当前页"上而不是整个 App：一页出错整站白屏（router.ts @why 里自述过），运营连换一页、退出登录都做不到；
 *      包在页面层，坏的只是这一页，侧栏还能去别处。
 * @why `resetKey` 一变就复位：运营点侧栏换页、或在订单之间切换后，不该还停在上一页的报错上。
 * @why 文案说"已自动报告给技术人员 + 刷新试试"，不展示错误原文：原文是英文技术信息（`Cannot read properties of undefined`），
 *      新手看了只会更慌；原文已随上报进了服务端日志。
 * @limitation 一：只接得住**渲染期**异常；事件处理函数、异步回调里的错误不经过错误边界，
 *              由 main.tsx 的全局 error / unhandledrejection 监听上报（不改页面显示）。
 * @limitation 二：React 开发模式下，被接住的错误仍会在控制台打印一次（框架行为），不代表没接住。
 * @see ./error-report.ts；server/src/app/admin-client-error-routes.ts
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { describeThrown, type ErrorReporter } from './error-report.js';

export interface ErrorBoundaryProps {
  /** 当前页名（上报用，如 `orders`）。 */
  page: string;
  /** 变化即复位（换页 / 换一单）。 */
  resetKey: string;
  reporter: ErrorReporter;
  children: ReactNode;
}

interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, State> {
  override state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    const d = describeThrown(error);
    // 组件栈比 JS 调用栈更能说明"哪一块坏了"（压缩构建下 JS 栈只有行列号）
    const stack = [d.stack, info.componentStack]
      .filter((s) => typeof s === 'string' && s !== '')
      .join('\n--- component stack ---\n');
    this.props.reporter.report({
      kind: 'render',
      message: d.message,
      stack,
      page: this.props.page,
    });
  }

  override componentDidUpdate(prev: ErrorBoundaryProps): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey)
      this.setState({ failed: false });
  }

  override render(): ReactNode {
    // 包一层 `display: contents` 的标记节点：不改 `.main` 的 flex 布局，又让 App 的接线可被测试看见
    return (
      <div className="page-boundary" data-page={this.props.page}>
        {this.state.failed ? <Fallback /> : this.props.children}
      </div>
    );
  }
}

function Fallback(): ReactNode {
  return (
    <section className="panel" role="alert" aria-label="页面出错">
      <h1 className="title">这个页面出错了</h1>
      <p>已自动报告给技术人员。可以先刷新试试；侧栏的其它页面不受影响。</p>
      <p className="muted">如果反复出现，请把出错的时间和你刚才的操作告诉技术人员。</p>
      <button type="button" className="btn" onClick={() => window.location.reload()}>
        刷新页面
      </button>
    </section>
  );
}
