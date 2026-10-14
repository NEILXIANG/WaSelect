/**
 * 职责：首页工作台（AJ-393；管理后台对标分析第一批③）——今日待办 + 今日 / 近 7 日数据。
 *
 * @why 待办放**第一屏**且每一项可点直达筛好的列表：成熟电商后台的共同做法是
 *      "打开就知道今天该干什么"。此前运营要自己逐页翻（附件 §3.1），
 *      而"待发货"是有发货时限承诺的一类，漏掉是真实损失。
 * @why 待办计数**复用订单页的 `TodoBar`**（它用列表接口的 `total`，`size=1`）：
 *      同一个数字有两条口径时，漂移的表现是"工作台写着 3、点进去列表只有 2 条"，
 *      而两边各自都自洽、没有任何一处会报错。复用 = 口径只有一份。
 *
 * @limitation 一：**日元为主、USD 灰字辅显、标 ≈**（对标分析 §8-2）。
 *              USD 只是"方便与 Stripe 后台 / 买家沟通"的换算，不是记账值；
 *              换算走 shared 的 `toMinor(toRateInt(rate), …)`——**唯一**换算入口，
 *              不在这里另写一次乘法（B43 那一类教训：写第二份迟早漂移）。
 * @limitation 二：**实收 / 已退 / 拒付按扣款币种原样显示，不折算**。
 *              这三个数要和支付机构对账（§8-2），折算后对不上；
 *              所以它们按币种**分行**显示，而不是加成一个"总退款额"。
 * @limitation 三：加载中显示「…」、失败显示「—」，**不显示 0**。
 *              "取不到"与"真的是 0"在经营判断里是两件事——
 *              把前者显示成 0 会让运营以为今天一分钱没卖出去。
 *
 * @see ./api.ts；../orders/TodoBar.tsx（待办计数）；../format.ts（金额文案）；
 *      ../../../server/src/adapters/dashboard.ts（服务端口径）
 */
import { useEffect, useState, type JSX } from 'react';
import { toMinor, toRateInt } from '@waselect/shared';
import { moneyText, minorMoneyText } from '../format.js';
import { ToastStack, toastError, useToasts } from '../ui/toast.js';
import { TodoBar } from '../orders/TodoBar.js';
import { FunnelCard } from './FunnelCard.js';
import {
  getSalesOverview,
  type AdminApi,
  type MoneyByCurrency,
  type SalesOverviewLike,
} from './api.js';
import type { Route } from '../router.js';

export interface DashboardPageProps {
  api: AdminApi;
  /** 待办点一下 → 跳到筛好的订单列表（`#/orders?status=paid`）。 */
  onNavigate: (next: Route) => void;
}

/**
 * 日元 → USD 的**辅显**文案；拿不到汇率或换算不可行时返回 `null`（不显示那一行）。
 *
 * @why 吞掉 `RangeError` 而不是让它冒泡：`toRateInt` 会拒 0 / 负 / 过大的汇率，
 *      那是"汇率配错了"，它已经有服务端与运维侧的告警；
 *      工作台**少显示一行 ≈USD** 是对的降级，让整页崩掉是错的降级。
 */
/**
 * 销售额卡片的辅行（ADM-7 / S3，AJ-469）：
 * ① 按收款时刻求和、**含后来整单退款的单**（退掉的在下方「已退」）；② ≈USD 用的是含缓冲的展示汇率，不是市场价。
 */
export function salesSubText(jpy: unknown, rate: unknown, period: 'today' | '7d'): string {
  const usd = usdApproxText(jpy, rate);
  // 规律排查 2026-10-12：下方「已退」只算今天，近 7 天的卡不能指过去
  const tail =
    period === 'today' ? '含后来退款的单，退款见下方「已退」' : '含后来退款的单（不扣退款）';
  return `${usd === null ? '' : `${usd}（按含缓冲的展示汇率）· `}${tail}`;
}

export function usdApproxText(jpy: unknown, rate: unknown): string | null {
  if (typeof jpy !== 'number' || typeof rate !== 'number') return null;
  try {
    return `≈ ${minorMoneyText(toMinor(jpy, toRateInt(rate)), 'USD')}`;
  } catch {
    return null;
  }
}

/** 一组"按币种分行"的钱 → 展示文案；空数组 → 「无」。 */
function moneyRowsText(rows: readonly MoneyByCurrency[] | undefined): string {
  if (rows === undefined || rows.length === 0) return '无';
  return rows.map((m) => minorMoneyText(m.amount, m.currency)).join(' / ');
}

/**
 * 经营词的白话解释（AJ-410 / N9）：卡片上一行小字常显 + 悬停提示。
 * @why 只做悬停的话，新手不知道"可以悬停"；常显一行小字最稳。
 */
export const TERM_HINTS: Readonly<Record<string, string>> = {
  客单价: '平均每单金额（销售额 ÷ 已付款订单数）',
  实收: '买家实际付到店里的钱',
  已退: '已经退还给买家的钱',
  拒付: '买家通过银行或信用卡公司把钱要回去（需要尽快处理）',
};

function Card({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string | null;
}): JSX.Element {
  const hint = TERM_HINTS[label];
  return (
    <div className="stat-card" title={hint}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
      {sub !== undefined && sub !== null && <span className="stat-sub">{sub}</span>}
      {hint !== undefined && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function DashboardPage({ api, onNavigate }: DashboardPageProps) {
  const [data, setData] = useState<SalesOverviewLike | null>(null);
  const [failed, setFailed] = useState(false);
  const toasts = useToasts();
  // ⚠️ 依赖数组里只能放**稳定**的那一个函数：`useToasts()` 每次渲染返回新对象，
  //    把整个 `toasts` 放进依赖会让它每次渲染都重新拉一次统计（乃至死循环）。
  //    `toasts.error` 是 `useCallback([push])` 且 `push` 是 `useCallback([])`，引用稳定。
  const { error: showError } = toasts;

  useEffect(() => {
    let alive = true;
    getSalesOverview(api)
      .then((r) => {
        if (alive) setData(r);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setFailed(true);
        const t = toastError(e, '工作台数据加载失败');
        showError(t.text, { traceId: t.traceId });
      });
    return () => {
      alive = false;
    };
  }, [api, showError]);

  /**
   * 全局停售（规律排查 2026-10-12）：原先只在「运营配置」页显示——紧急停售后忘了恢复，工作台照常、买家却下不了单。
   * @limitation 取失败不提示（工作台主体不受它影响）；只在打开工作台时取一次。
   */
  const [pause, setPause] = useState<{ reason?: string } | null>(null);
  useEffect(() => {
    let alive = true;
    api({ path: '/api/v1/admin/ops/sales-pause', method: 'GET' })
      .then((r) => {
        const s = r as { paused?: unknown; reason?: unknown } | null;
        if (alive && s?.paused === true)
          setPause(typeof s.reason === 'string' ? { reason: s.reason } : {});
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  const rate = data?.fx?.usd_rate;
  const today = data?.today;
  const last7 = data?.last7;

  return (
    <div>
      <ToastStack toasts={toasts.toasts} onDismiss={(id) => toasts.dismiss(id)} />
      {pause !== null && (
        <section className="panel">
          <p className="error" role="alert">
            ⛔ 店铺已暂停接单：买家现在无法报价、下单、付款
            {pause.reason !== undefined ? `（原因：${pause.reason}）` : ''}。{' '}
            <a className="link" href="#/ops">
              去「运营配置」恢复接单 →
            </a>
          </p>
        </section>
      )}

      <section className="panel">
        <h2 className="title">今日待办</h2>
        <p className="muted">点下面的按钮，直接打开要处理的那些订单</p>
        <TodoBar
          api={api}
          current="all"
          onPick={(q) => {
            onNavigate({ page: 'orders', id: '', query: new URLSearchParams(q) });
          }}
        />
      </section>

      <section className="panel">
        <h2 className="title">今日数据</h2>
        {/* 服务端按日本时间切天（jstDayWindow）——在中国的同事看到的"今天"晚上 11 点就换了（规律排查 2026-10-12） */}
        <p className="muted">按日本时间算（每天 0 点起算）</p>
        <div className="stat-cards">
          <Card
            label="销售额"
            value={today === undefined ? (failed ? '—' : '…') : moneyText(today.sales_jpy ?? 0)}
            sub={salesSubText(today?.sales_jpy ?? 0, rate, 'today')}
          />
          <Card
            label="已付款订单"
            value={today === undefined ? (failed ? '—' : '…') : String(today.paid_orders ?? 0)}
          />
          <Card
            label="客单价"
            value={
              today === undefined
                ? failed
                  ? '—'
                  : '…'
                : today.avg_jpy === null || today.avg_jpy === undefined
                  ? '—'
                  : moneyText(today.avg_jpy)
            }
          />
        </div>
      </section>

      <section className="panel">
        <h2 className="title">近 7 天</h2>
        <p className="muted">含今天，按日本时间算</p>
        <div className="stat-cards">
          <Card
            label="销售额"
            value={last7 === undefined ? (failed ? '—' : '…') : moneyText(last7.sales_jpy ?? 0)}
            sub={salesSubText(last7?.sales_jpy ?? 0, rate, '7d')}
          />
          <Card
            label="已付款订单"
            value={last7 === undefined ? (failed ? '—' : '…') : String(last7.paid_orders ?? 0)}
          />
          <Card
            label="客单价"
            value={
              last7 === undefined
                ? failed
                  ? '—'
                  : '…'
                : last7.avg_jpy === null || last7.avg_jpy === undefined
                  ? '—'
                  : moneyText(last7.avg_jpy)
            }
          />
        </div>
      </section>

      {/* 第 25 项（AJ-438）：转化漏斗——客人卡在哪一步 */}
      <FunnelCard api={api} />

      <section className="panel">
        <h2 className="title">今日实收 / 已退 / 拒付</h2>
        <p className="muted">
          按买家实际付款用的币种显示（付的是美元就显示美元，不换算成日元），方便和支付平台后台的记录一笔一笔核对。「今日」按日本时间算。
        </p>
        <div className="form">
          {(
            [
              ['实收', today?.received],
              ['已退', today?.refunded],
              ['拒付', today?.disputed],
            ] as const
          ).map(([label, rows]) => (
            <span key={label} title={TERM_HINTS[label]}>
              {label}：{moneyRowsText(rows)}
              <span className="stat-hint"> （{TERM_HINTS[label]}）</span>
            </span>
          ))}
        </div>
      </section>
    </div>
  );
}
