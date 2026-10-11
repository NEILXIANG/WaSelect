/**
 * 职责：运费表的**内容指纹**（ADM-4 / AJ-458）——管理端整表保存时带上"我读到的那张表"的指纹，
 *      服务端在表锁内比对，两人同时编辑时后保存的一方得到 40914 而不是静默覆盖。
 *
 * @why 不加 `updated_at` / 版本列：整表替换是 delete + insert，没有一行是"同一行"，版本号无处可挂；
 *      内容指纹天然就是"这张表现在长什么样"，前后端用同一个纯函数各算一遍即可，不需要服务端额外返回。
 * @why FNV-1a 32 位而不是 SHA-256：浏览器端 Web Crypto 是异步的，而这里只要"内容变没变"的判定，不是防伪；
 *      运费表只有个位数行，碰撞概率可忽略（真碰撞的后果也只是一次本该被拦的保存没被拦）。
 * @limitation 只看四个业务字段（承运商 / 上限 / 价格 / 启用），与行顺序无关；`active` 缺省按契约 default true。
 * @see server/src/adapters/ops-config.ts（锁内比对）；admin-web/src/ops/RatesPanel.tsx（保存时带上）
 */
export interface ShippingRateLike {
  carrier: string;
  max_weight_g: number;
  price_jpy: number;
  active?: boolean | undefined;
}

export function shippingRatesFingerprint(rows: readonly ShippingRateLike[]): string {
  const canon = rows
    .map(
      (r) =>
        `${r.carrier}\u0001${String(r.max_weight_g)}\u0001${String(r.price_jpy)}\u0001${r.active === false ? '0' : '1'}`,
    )
    .sort()
    .join('\u0002');
  let h = 0x811c9dc5;
  for (let i = 0; i < canon.length; i += 1) {
    h ^= canon.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}
