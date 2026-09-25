/**
 * 职责：登录占位页（F15 单元③）——邮箱+密码表单，提交走 endpoints.login 的真实请求路径。
 * 边界：只做表单与错误展示；登录语义在 api/endpoints.ts。
 *
 * @why 错误展示带 traceId（`报障码`）：N8 的落地——管理员报障时给出一个 ID，
 *      服务端按它检索日志；只显示"登录失败"四个字，排障只能靠猜时间点。
 *
 * @limitation 一：不做前端密码强度校验（契约 minLength 10 由服务端兜底）——
 *              前端校验只挡"明显空值"，强度规则两处维护必然漂移。
 * @limitation 二：连续失败 5 次锁 15 分钟是**服务端**限流（RATE_LIMIT_LOGIN_PER_15MIN）——
 *              前端不做计数（可绕过，且会给暴力破解者"还剩几次"的提示）；42901 按普通错误展示。
 *
 * @see contracts/api-contract.yaml /auth/admin/login；./api/endpoints.ts
 */
import { useState, type FormEvent } from 'react';
import { ApiError } from './api/errors.js';

export function LoginForm({
  onLogin,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return; // 防连点：重复提交打的是同一个登录接口，服务端限流会先受不了
    setError('');
    setBusy(true);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      // 只展示可机读错误的 message；未知异常（代码 bug）给通用文案——细节在控制台与 traceId
      setError(
        err instanceof ApiError
          ? `${err.message}（报障码：${err.traceId}）`
          : '登录失败，请稍后重试',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="page">
      <form className="card" onSubmit={(e) => void handleSubmit(e)}>
        <h1 className="title">管理后台登录</h1>
        <label className="field">
          <span className="label">邮箱</span>
          <input
            className="input"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="field">
          <span className="label">密码</span>
          <input
            className="input"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {error !== '' && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button className="btn" type="submit" disabled={busy}>
          {busy ? '登录中…' : '登录'}
        </button>
      </form>
    </main>
  );
}
