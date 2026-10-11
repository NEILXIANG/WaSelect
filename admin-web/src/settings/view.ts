/**
 * 职责：设置页（AJ-404；对标分析 §4.8）的文案与值呈现——项名、组名、值、"改它怎么生效"。
 *
 * @why 文案在前端、服务端只给稳定 `key`（约束五：文案不写死在业务代码里）；服务端新加一项而这里还没登记时
 *      原样显示 key，不吞掉——少一个中文名比少一行配置好查。
 * @why 三种"空"分开说：`null` = 未填写；带 `edit_page` = 去那一页看；`false` = 未开通（通知类）。
 * @why AJ-410 / N31：主文案只说运营能懂的话（"未填写，上线前请让技术人员配置""技术人员在服务器上修改"），
 *      环境变量名（SELLER_NAME…）这类给技术人员的信息由 {@link techText} 单独给，页面上收进折叠的「技术信息」。
 * @why 关税率按字符串移位成百分比，不做浮点乘法：`0.13040 × 100` 在浮点里是 13.040000000000001。
 * @limitation 支付通道"仅处理存量订单"= 凭据在但不在 PAYMENT_CHANNELS 里（服务端 offline 语义）；
 *             这里只转述 `enabled`，不推断原因。
 * @see ../../../server/src/app/settings-view.ts（白名单与 key 的唯一出处）
 */

export interface SettingItemLike {
  key: string;
  value: unknown;
  source: string;
  apply: string;
  env?: string;
  edit_page?: string;
}

const GROUP_TITLES: Readonly<Record<string, string>> = {
  shop: '店铺信息',
  payment: '支付',
  shipping: '运费',
  tax: '税费',
  notify: '通知',
  fx: '汇率',
};

const ITEM_LABELS: Readonly<Record<string, string>> = {
  seller_name: '商家名称',
  seller_representative: '代表人',
  seller_address: '商家地址',
  seller_phone: '商家电话',
  seller_email: '商家邮箱',
  support_email: '客服邮箱',
  support_wechat: '客服微信',
  support_hours: '客服时间',
  terms_version: '条款版本',
  legal_base_url: '法务页站点',
  payment_channels: '支付通道',
  checkout_base_url: '支付落地页站点',
  review_mode: '审核模式',
  review_mode_until: '审核模式截止日（UTC）',
  review_sku_id: '审核商品',
  max_order_jpy: '单笔订单上限（円）',
  order_payment_ttl_min: '待支付保留（分钟）',
  shipping_rates: '运费分档',
  packaging_weight_g: '包材重量（g）',
  free_shipping_jpy: '包邮门槛（円）',
  ship_within_business_days: '承诺发货（工作日）',
  auto_deliver_days: '发货后自动签收（天）',
  auto_complete_days: '签收后自动完成（天）',
  duty_rates: '关税率',
  mail_configured: '订单通知邮件',
  alert_email_configured: '运维告警邮箱',
  sentry_configured: '错误上报（Sentry）',
  fx_rates: '展示汇率',
  fx_buffer_rate: '汇率缓冲',
  fx_max_age_hours: '汇率最长有效（小时）',
  display_currencies: '展示币种',
};

export function groupTitle(key: string): string {
  return GROUP_TITLES[key] ?? key;
}

export function itemLabel(key: string): string {
  return ITEM_LABELS[key] ?? key;
}

/** `"0.13040"` → `"13.04"`（字符串移两位，去掉尾零）。 */
function ratePercent(rate: string): string {
  const [int = '0', frac = ''] = rate.split('.');
  const padded = frac.padEnd(2, '0');
  const whole = String(Number(`${int}${padded.slice(0, 2)}`));
  const rest = padded.slice(2).replace(/0+$/, '');
  return rest === '' ? whole : `${whole}.${rest}`;
}

function channelText(ch: Record<string, unknown>): string {
  const cur = Array.isArray(ch['currencies']) ? (ch['currencies'] as string[]).join('/') : '';
  const rest = [
    ch['enabled'] === true ? '接受新订单' : '只处理已有订单',
    `排序 ${String(ch['priority'])}`,
    cur,
  ].join(' · ');
  return `${String(ch['label'])} · ${rest}`;
}

/** 支付通道的技术信息（通道代号、属性来源）——收进「技术信息」。 */
function channelTech(ch: Record<string, unknown>): string {
  const src = ch['attrs_source'] === 'table' ? '属性来自配置表' : '属性来自内置默认';
  return `${String(ch['channel'])}：${src}`;
}

/** 没填的配置项（N31）。 */
export const NOT_SET = '未填写，上线前请让技术人员配置';

export function valueText(item: SettingItemLike): string {
  const v = item.value;
  if (item.edit_page === 'ops') return '在「运营配置」页查看与修改';
  if (v === null || v === undefined) return NOT_SET;
  if (typeof v === 'boolean') return v ? '已开通' : '未开通，上线前请让技术人员配置';
  // 三端模拟测试 2026-10-11：原样显示 on / off，运营看不懂；审核期只许模拟通道（config.ts 启动闸门）
  if (item.key === 'review_mode' && (v === 'on' || v === 'off')) {
    return v === 'on' ? '开启（只收模拟支付，审核用）' : '关闭';
  }
  if (item.key === 'fx_buffer_rate' && typeof v === 'number') {
    return `${ratePercent(String(v))}%`;
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return NOT_SET;
    if (item.key === 'payment_channels') {
      return v.map((c) => channelText(c as Record<string, unknown>)).join('；');
    }
    if (item.key === 'duty_rates') {
      return v
        .map((d) => {
          const r = d as Record<string, unknown>;
          return `${String(r['origin'])} → ${String(r['dest'])}：${ratePercent(String(r['rate']))}%`;
        })
        .join('；');
    }
    return v.map(String).join('、');
  }
  return String(v);
}

export function applyText(item: SettingItemLike): string {
  const when = item.apply === 'immediate' ? '立即生效' : '改后需重启';
  if (item.source === 'db') return `在后台修改 · ${when}`;
  return `技术人员在服务器上修改 · ${when}`;
}

/**
 * 给技术人员的信息（环境变量名 / 存放位置 / 支付通道代号），页面上收进折叠的「技术信息」（N31）。
 * @limitation 密钥类（没有 `env` 名的）只说"部署环境变量"——服务端白名单本就不下发它们的名字。
 */
export function techText(item: SettingItemLike): string {
  if (item.key === 'payment_channels' && Array.isArray(item.value)) {
    return item.value.map((c) => channelTech(c as Record<string, unknown>)).join('；');
  }
  if (item.source === 'db') return '存放在数据库';
  return item.env !== undefined ? `环境变量 ${item.env}` : '部署环境变量';
}
