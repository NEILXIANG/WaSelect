/**
 * 职责：登录占位页（F15 单元③）——邮箱+密码表单，提交走 endpoints.login 的真实请求路径。
 * 边界：只做表单与错误展示；登录语义在 api/endpoints.ts。
 *
 * @why 错误展示带 traceId（`报障码`）：N8 的落地——管理员报障时给出一个 ID，
 *      服务端按它检索日志；只显示"登录失败"四个字，排障只能靠猜时间点。
 *
 * @why 失败文案由 `auth-view.ts` 的 `loginErrorText` 给（P2-43）：40101 在登录页的意思是
 *      "邮箱或口令不对"，照搬通用注册表的"未登录或登录已过期"会把人引向错误方向；
 *      42901 读 `retry-after` 头说清还要等几分钟。
 *
 * @limitation 一：前端只预检**长度**（`ADMIN_PASSWORD_MIN_LENGTH`，与服务端同源 shared 常量），
 *              不做强度规则——强度以服务端为准，两处维护必然漂移。
 * @limitation 二：连续失败锁定是**服务端**限流——前端不做计数（可绕过，且会给暴力破解者
 *              "还剩几次"的提示）；只转述服务端给的等待时长。
 *
 * @see contracts/api-contract.yaml /auth/admin/login；./api/endpoints.ts
 */
import { useState, type FormEvent } from 'react';
import { loginErrorText, loginPrecheck } from './auth-view.js';

export function LoginForm({
  onLogin,
  title = '管理后台登录',
  hint = '',
  bare = false,
}: {
  onLogin: (email: string, password: string) => Promise<void>;
  /** 标题（会话过期浮层里改成"登录已过期，请重新登录"）。 */
  title?: string;
  /** 标题下的说明（浮层里用来告诉管理员"你填的内容还在"）。 */
  hint?: string;
  /** true = 不包 `<main className="page">`（嵌在浮层里时用）。 */
  bare?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return; // 防连点：重复提交打的是同一个登录接口，服务端限流会先受不了
    const pre = loginPrecheck(password);
    if (pre !== '') {
      setError(pre);
      return;
    }
    setError('');
    setBusy(true);
    try {
      await onLogin(email.trim(), password);
    } catch (err) {
      // 未知异常（代码 bug）给通用文案——细节在控制台与 traceId
      setError(loginErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className="card" onSubmit={(e) => void handleSubmit(e)}>
      <h1 className="title">{title}</h1>
      {hint !== '' && <p className="muted">{hint}</p>}
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
  );
  return bare ? form : <main className="page">{form}</main>;
}
