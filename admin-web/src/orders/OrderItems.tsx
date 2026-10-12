/**
 * 职责：订单详情主区的商品表——每个行项目一行"买了什么、多少钱"，下面紧跟一行采购信息（AJ-398 从 OrderDetail 拆出）。
 *
 * @why 采购信息另起一行：它是**执行依据**（照这三样去买），与上一行用途不同，挤在一行里谁都读不清。
 * @limitation 缩略图只收 http(s)；其余（含 data: / 相对路径）一律不显示，不猜。
 * @see ./view.ts（purchaseLine）
 */
import { Fragment } from 'react';
import { moneyText } from '../format.js';
import { purchaseLine } from './view.js';

/** 行项目首图的 thumb（只收 http(s)；三端联动 UI 模拟 2026-10-08）。 */
function itemThumb(it: Record<string, unknown>): string {
  const t = (it['image'] as { thumb?: unknown } | undefined)?.thumb;
  return typeof t === 'string' && /^https?:\/\//.test(t) ? t : '';
}

export function OrderItems({ items }: { items: ReadonlyArray<Record<string, unknown>> }) {
  return (
    <div className="field">
      <span className="label">商品</span>
      {items.length === 0 ? (
        <span className="muted">—</span>
      ) : (
        <table className="table">
          <tbody>
            {items.map((it, i) => (
              <Fragment key={i}>
                <tr>
                  <td>
                    {/* 图与名并排；名最多两行、悬停看全文（全入口点击测试 2026-10-12：长礼盒名把一行撑成 7 行） */}
                    <div className="item-with-thumb">
                      {itemThumb(it) !== '' && (
                        <img className="thumb" src={itemThumb(it)} alt="" loading="lazy" />
                      )}
                      <span className="item-name clamp-2" title={String(it['title'] ?? '')}>
                        {String(it['title'] ?? '')}
                      </span>
                    </div>
                  </td>
                  <td>× {String(it['qty'] ?? '')}</td>
                  <td>{moneyText(it['unit_price_jpy'])}</td>
                </tr>
                {/* 采购信息另起一行：它是**执行依据**（照这三样去买），
                与上面那行"买了什么、多少钱"是两种用途，挤在一行里谁都读不清。
                走 `purchaseLine` 而不是直接拼字段：缺的字段要显示「未记录」，
                三样全缺时还要说清"这单建于采购信息录入之前"——
                省略会让人分不清"商品没有"和"系统没记"。 */}
                <tr className="row-sub">
                  <td colSpan={3}>{purchaseLine(it)}</td>
                </tr>
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
