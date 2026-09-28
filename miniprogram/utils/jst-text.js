/**
 * 职责：UTC ISO 时间串 → **JST 展示串**（`YYYY-MM-DD HH:mm`）——纯函数，**不用 `new Date`**。
 *
 * @why 订单详情页要显示时间线 / 建单时刻 / 截止时刻，而 `pages/**` 的 `*.vm.js`
 *      被 vm-guard 禁止出现 `new Date(`（约束十一：读了时钟就不可测）。
 *      ⚠️ `new Date(iso)` 其实是"解析"不是"读时钟"，但守卫的正则分不清这两样，
 *      为了不破坏"vm 里一个 `new Date(` 都没有"这条**形态级**红线，
 *      转换算法在这里用纯整数运算实现（Hinnant 的 days_from_civil / civil_from_days）。
 *
 * @why JST 而不是买家本地时区：与**管理端恒显 JST** 同一条口径（AJ-132 硬口径④），
 *      买家侧目前没有另外的时区口径；与其两端各漂各的，不如两端都用服务端所在时区。
 *      ⚠️ 美国买家看到的是日本时间——这在 PRD 里没有规定，属骨架期欠账，
 *      北美时区本地化（要 tz 数据表）是另一个单元的事。
 *
 * @limitation 一：只认 `...Z`（服务端 `toISOString()` 的形态）。带显式偏移（`+09:00`）
 *              的输入**直接返回 null** 而不是"假装它是 UTC"——把东京时间再 +9
 *              是静默错 9 小时，那比"显示原串"贵得多。
 * @limitation 二：输入是**服务端产出**的时间，不做严格历日校验（`2026-02-31`
 *              会被算法顺势滚成 3 月 3 日）。调用方若把用户手填串传进来，自己负责先校验。
 * @limitation 三：精度只到分（时间线不需要秒）。
 *
 * @see ../pages/order-detail/index.vm.js（第一个消费方）；miniprogram/vm-guard.unit.test.ts（红线）
 */

/** 公历 (y,m,d) → 自 1970-01-01 起的天数（Hinnant days_from_civil）。 */
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/** 天数 → 公历 (y,m,d)（Hinnant civil_from_days）。 */
function civilFromDays(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365,
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp + (mp < 10 ? 3 : -9);
  return { y: m <= 2 ? y + 1 : y, m, d };
}

/**
 * UTC ISO 串 → JST 展示串。
 * @param {unknown} iso 形如 `2026-09-27T15:04:26.000Z`
 * @returns {string|null} `2026-09-28 00:04`；解析不了 / 不是 UTC → **null**（调用方自行回落）
 */
export function jstDateTime(iso) {
  if (typeof iso !== 'string') return null;
  // ⚠️ 尾部只认 Z（@see @limitation 一）：带偏移的串宁可不转
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z$/);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;

  // UTC 分钟数 + 540（UTC+9；JST 无夏令时）
  const totalMin = daysFromCivil(y, mo, d) * 1440 + h * 60 + mi + 540;
  const days = Math.floor(totalMin / 1440);
  const rem = totalMin - days * 1440;
  const j = civilFromDays(days);
  const pad = (n) => String(n).padStart(2, '0');
  return `${j.y}-${pad(j.m)}-${pad(j.d)} ${pad(Math.floor(rem / 60))}:${pad(rem % 60)}`;
}
