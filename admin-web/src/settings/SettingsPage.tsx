/**
 * 职责：「设置」页（AJ-404；对标分析 §4.8）——**只读**展示当前生效的非密钥配置，标出每项"改它怎么生效"。
 *
 * @why 只读：env 只能在部署平台改、改完要重启；在这里放输入框会让运营以为改了就生效。
 *      能在后台改的（运费、汇率）给一个去「运营配置」页的链接。
 * @why 密钥一项都不在这里：服务端白名单制（settings-view.ts），通知类只给"是否已配置"。
 * @limitation 显示的是"本进程此刻生效的值"：env 改了还没重启时，这里仍是旧值——这正是它要告诉运营的。
 * @see ./view.ts；./api.ts
 */
import { useEffect, useState } from 'react';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { formatJst } from '../format.js';
import { getSettings, type AdminApi, type SettingsLike } from './api.js';
import { applyText, groupTitle, itemLabel, techText, valueText } from './view.js';

export function SettingsPage({ api }: { api: AdminApi }) {
  const [data, setData] = useState<SettingsLike | null>(null);
  const [loading, setLoading] = useState(true);
  const sink = useToasts();

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const d = await getSettings(api);
        if (alive) setData(d);
      } catch (e) {
        const { text, traceId } = toastError(e, '取设置失败');
        if (alive) sink.error(text, { traceId });
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, sink.error]);

  return (
    <section className="panel">
      <header className="panel-head">
        <h1 className="title">设置</h1>
        {loading && <span className="muted">加载中…</span>}
      </header>
      <p className="muted">
        这一页只能看、不能改：店铺信息等由技术人员在服务器上修改，改后需要重启；运费与汇率在{' '}
        <a className="link" href="#/ops">
          运营配置
        </a>{' '}
        页修改。
        {data?.generated_at !== undefined && `取数时刻 ${formatJst(data.generated_at)}（日本时间）`}
      </p>
      {data?.groups.map((g) => (
        <div className="form-card" key={g.key}>
          <span className="form-card-title">{groupTitle(g.key)}</span>
          <table className="table">
            <tbody>
              {g.items.map((it) => (
                <tr key={it.key}>
                  <td>{itemLabel(it.key)}</td>
                  <td className="selectable">
                    {valueText(
                      it,
                      data.groups.flatMap((x) => x.items),
                      new Date().toISOString().slice(0, 10),
                    )}
                  </td>
                  <td className="muted">{applyText(it)}</td>
                  <td>
                    <details className="tech-info">
                      <summary>技术信息</summary>
                      {techText(it)}
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      <ToastStack toasts={sink.toasts} onDismiss={sink.dismiss} />
    </section>
  );
}
