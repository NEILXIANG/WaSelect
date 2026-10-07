/**
 * 职责：`payment_channels` 配置表的**唯一读取口**（A2 / R2-4 接线，迁移 010 建表 + seed）。
 *
 * @why 单独成文件而不是塞进 `payment/channels.ts`：那份文件是**装配处**（把配置拼成注册表），
 *      它的全部 @why 都建立在"同步、无 I/O"之上；把 SQL 掺进去，等于让"装配"与"读库"
 *      两种职责共用一次失败模式（库不可用时到底是不注册还是崩？）。
 *      与 `country-profiles.ts`（国家档案的唯一读取口）同一个形态：
 *      **配置表的读法只有一份**，装配处只收结果。
 *
 * @why ⚠️ **刻意不读 `enabled` 列**（这是本接线最重要的一条取舍）：
 *      "开不开放"仍由 `PAYMENT_CHANNELS`（env 配置）单独决定。
 *      若让库里一行数据也能打开通道，`config.ts` 的三条安全闸门就被绕过了——
 *      生产 mock 只在审核期（规则 1 / 1b）、审核期只允许 mock（规则 2b）。
 *      那些闸门的判据是**配置**，而配置是启动期唯一被完整校验过的东西；
 *      库里的一行 UPDATE 不会经过任何一道闸门。
 *      所以本表的定位是**排序与展示**（迁移 010 的原话），不是开关。
 *      @limitation 一：代价是 `enabled` 列目前**没有消费方**——它是"将来若要接，
 *      必须做成与 env 的 AND（而不是 OR），并连带重估上面三条闸门"的记号。
 *
 * @limitation 二：**不缓存**。装配期只读一次（进程启动时），改数据要重启才生效。
 *              运行期热加载需要"改了之后在途订单用哪套属性"的答案，MVP 没有，
 *              先做成"重启生效"这个**说出口的**口径，而不是留一个静默的缓存。
 * @limitation 三：读到**全部行**（不按任何条件过滤），由装配处按通道名取用。
 *              表里没有的通道走内置默认值（`@see payment/channels.ts` 的 CHANNEL_DEFAULTS），
 *              所以"表里少一行"的表现是**静默回退**而不是报错——
 *              这个回退必须能被看见（装配处把它记进启动日志 `attrs_source`）。
 *
 * @see migrations/010_config_tables.sql（表与三行 seed）；
 *      adapters/payment/channels.ts（装配处，本文件的唯一消费方）；
 *      adapters/payment/payment-channels-seed.db.test.ts（seed ↔ CHANNEL_DEFAULTS 同源比对）
 */
import type { Db } from './db.js';

/** 通道的**展示与匹配属性**（不含开关——见文件头 @why）。 */
export interface ChannelConfigRow {
  channel: string;
  /** 小者优先。 */
  priority: number;
  countries: readonly string[];
  currencies: readonly string[];
  label: string;
  icon: string | undefined;
}

interface RawRow {
  channel: string;
  priority: number;
  countries: unknown;
  currencies: unknown;
  label: string;
  icon: string | null;
}

/**
 * JSONB 列取出来必须是**非空的范围码数组**：元素是 `*`，或国家码（两位大写）/ 币种码（三位大写）。
 *
 * @why 不校验的后果是"静默不匹配"：`countries` 若是 `[1,2]` 或 `'US'`（不是数组），
 *      `matchesScope` 会一路返回 false，表现是**这个通道在所有市场都不出现**——
 *      而它长得跟"这个通道被下线了"一模一样（空对空那一类失效）。
 *      宁可启动期抛错（改数据即可恢复），也不要让运营去猜通道为什么消失。
 * @why 空数组与小写码同属这一类（工程缺口第二轮复核 F2）：迁移的 CHECK 只管 `jsonb_typeof = 'array'`，
 *      `[]` 与 `["us"]` 都进得了库，而 `matchesScope` 按大写码精确比对——原先只查"是字符串"，两者都漏。
 * @limitation 只校验**形状**，不校验"US 是不是真实存在的国家码"；那由 country_profiles 与能力声明兜。
 */
export function scopeArray(
  value: unknown,
  channel: string,
  field: 'countries' | 'currencies',
): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`payment_channels[${channel}].${field} 不是数组（JSONB 列必须是数组）`);
  }
  if (value.length === 0) {
    throw new Error(
      `payment_channels[${channel}].${field} 是空数组（= 在所有市场都不出现；不限请写 ["*"]）`,
    );
  }
  const shape = field === 'countries' ? /^[A-Z]{2}$/ : /^[A-Z]{3}$/;
  return value.map((v) => {
    if (typeof v !== 'string') {
      throw new Error(`payment_channels[${channel}].${field} 含非字符串元素：${String(v)}`);
    }
    if (v !== '*' && !shape.test(v)) {
      throw new Error(
        `payment_channels[${channel}].${field} 含不合形状的值：${v}（应为 * 或${field === 'countries' ? '两位' : '三位'}大写码）`,
      );
    }
    return v;
  });
}

/** 读取全部通道属性（按 channel 排序，便于日志与测试稳定比对）。 */
export async function loadChannelConfigs(db: Db): Promise<readonly ChannelConfigRow[]> {
  const rows = await db<RawRow[]>`
    select channel, priority, countries, currencies, label, icon
      from payment_channels
     order by channel
  `;
  return rows.map((r) => ({
    channel: r.channel,
    priority: r.priority,
    countries: scopeArray(r.countries, r.channel, 'countries'),
    currencies: scopeArray(r.currencies, r.channel, 'currencies'),
    label: r.label,
    icon: r.icon ?? undefined,
  }));
}
