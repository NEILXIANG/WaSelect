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
 *              "还剩几次"的提示）；只转述服务端给的等待时长，以及输错时提醒一句锁定**规则**（N6，数字取 shared 常量）。
 *
 * @why 新手可用性（AJ-410 / N1～N5）：登录卡居中并写明「WaSelect 管理后台」；第三格叫「手机验证码」并说清是什么；
 *      没有自助找回，明说"忘记密码找店铺负责人"（重置走 scripts/admin-password.ts）；
 *      密码框可切换"显示密码"——实测新手 Cmd+A 没选中，新密码被追加在旧内容后面而看不见；
 *      报障码不进红字，单独一行（TraceLine）。
 *
 * @see contracts/api-contract.yaml /auth/admin/login；./api/endpoints.ts
 */
import { useState, type FormEvent } from 'react';
import { loginErrorText, loginPrecheck, type LoginErrorView } from './auth-view.js';
import { TraceLine } from './ui/trace.js';

/** 没有自助找回密码（N3）：重置由店铺负责人用 `npm run admin:password` 做。 */
export const FORGOT_PASSWORD_HINT = '忘记密码？请联系店铺负责人重置';

const NO_ERROR: LoginErrorView = { text: '', hint: '', traceId: '' };

export function LoginForm({
  onLogin,
  title = '登录',
  hint = '',
  bare = false,
}: {
  /** totp：手机验证码（P1-5），没开 TOTP 的账号留空即可。 */
  onLogin: (email: string, password: string, totp: string) => Promise<void>;
  /** 标题（会话过期浮层里改成"登录已过期，请重新登录"）。 */
  title?: string;
  /** 标题下的说明（浮层里用来告诉管理员"你填的内容还在"）。 */
  hint?: string;
  /** true = 不包 `<main className="page">`（嵌在浮层里时用）。 */
  bare?: boolean;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [totp, setTotp] = useState('');
  const [error, setError] = useState<LoginErrorView>(NO_ERROR);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy) return; // 防连点：重复提交打的是同一个登录接口，服务端限流会先受不了
    // ⚠️ email.trim() 也要进预检：空邮箱原本只能靠 <input required> 的原生气泡提示（见 auth-view.loginPrecheck 的 @why）
    const pre = loginPrecheck(email, password, totp.trim());
    if (pre !== '') {
      setError({ ...NO_ERROR, text: pre });
      return;
    }
    setError(NO_ERROR);
    setBusy(true);
    try {
      await onLogin(email.trim(), password, totp.trim());
      setTotp(''); // 码一次性（服务端防重放）；留着会让下一次登录拿旧码撞 40101
    } catch (err) {
      // 未知异常（代码 bug）给通用文案——细节在控制台与 traceId
      setError(loginErrorText(err));
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className="card" onSubmit={(e) => void handleSubmit(e)}>
      <p className="login-brand">WaSelect 管理后台</p>
      <h1 className="title">{title}</h1>
      {hint !== '' && <p className="muted">{hint}</p>}
      <label className="field">
        <span className="label">邮箱</span>
        <input
          className="input"
          type="email"
          required
          autoComplete="username"
          placeholder="例：name@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </label>
      <div className="field">
        <label className="label" htmlFor="login-password">
          密码
        </label>
        <div className="password-row">
          <input
            id="login-password"
            className="input"
            type={showPassword ? 'text' : 'password'}
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {/* N4：看得见才知道自己打了什么（全选失败时新密码会被追加在旧内容后面） */}
          <button
            type="button"
            className="btn btn-secondary"
            aria-pressed={showPassword}
            onClick={() => setShowPassword((v) => !v)}
          >
            {showPassword ? '隐藏密码' : '显示密码'}
          </button>
        </div>
      </div>
      <label className="field">
        <span className="label">手机验证码（没开通就留空）</span>
        <input
          className="input"
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          pattern="[0-9]{6}"
          placeholder="例：123456"
          value={totp}
          onChange={(e) => setTotp(e.target.value)}
        />
        <span className="muted">
          手机上的验证器 App（如 Google Authenticator）里显示的 6
          位数字，不是短信；没开通过就不用填。
        </span>
      </label>
      {error.text !== '' && (
        <div role="alert">
          <p className="error">{error.text}</p>
          {error.hint !== '' && <p className="muted">{error.hint}</p>}
          <TraceLine traceId={error.traceId} />
        </div>
      )}
      <button className="btn" type="submit" disabled={busy}>
        {busy ? '登录中…' : '登录'}
      </button>
      <p className="muted">{FORGOT_PASSWORD_HINT}</p>
    </form>
  );
  // N1：登录卡居中（`.page` 是登录后的多页布局，靠左顶部对齐）
  return bare ? form : <main className="page login-page">{form}</main>;
}
