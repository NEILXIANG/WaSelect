/**
 * 职责：收货地址的**表单模型与格式校验**（共享层；地址列表页与编辑页都用）。
 *
 * @why 独立成共享模块而不是塞进页面：地址在两处被用——**编辑页**要校验并组装请求体，
 *      **确认订单页**要渲染一行摘要。写两遍的结果是"编辑页说格式对、列表页显示成空的"，
 *      且两边各自的正则会各自漂移。
 *
 * @why 前端要**重复一遍**契约的 pattern（而不是等服务端 400）：
 *      地址表单七个字段，让用户提交后才知道"电话少了 +1"是纯粹的浪费——
 *      一次往返换一条错误信息，而这条信息客户端**本来就知道**。
 *      ⚠️ 但**服务端仍是权威**：这里是"预检"，不是"放行"。
 *      两处正则不一致的表现是"前端说对、服务端 400"，由单测与契约双向比对钉住
 *      （同首页分类枚举的做法）。
 *
 * @limitation 一：`country` 在 MVP 固定取 `ADDRESS_COUNTRY_DEFAULT`（'US'）——
 *              单一目的国是这个阶段的事实（PRD：先做美国）。
 *              ⚠️ 它是**常量不是散落的字面量**：多国时改这里一处 + 服务端下发默认即可，
 *              禁止在页面/wxml 里再写一个 'US'（ADR-28：不写死国家）。
 * @limitation 二：`state` 一律 `toUpperCase()`：契约只约束长度 2 不约束大小写，
 *              而美国州名的语义是大写（小写 `ca` 在报关与面单上会被当成另一个值）。
 *              自动转比报错友好——用户没有"输错大小写"这个概念。
 * @limitation 三：校验只报**字段级**错误，不做国际化 / 不做地址标准化（不调 USPS）。
 *              能标准化的地址在服务端落库时也不会改格式，MVP 不引这条路。
 *
 * @see ../../contracts/api-contract.yaml（AddressInput：pattern 的**真源**）；
 *      ../pages/address/index.vm.js（列表行）；../pages/checkout/（建单时用它摘要）
 */
import { isUsStateCode, US_STATE_ROWS } from './us-states.js';

/**
 * 地址编辑页顶部说明（M-20，AJ-406）：先说"为什么要英文"，再给一行示例。
 *
 * @why 此前"要用英文"只在提交后的字段错误里出现（`validateAddress` 的"请用英文/数字填写"）——
 *      首次下单的人填完一整张中文地址才被告知全部重填。说明放在表单之前，错误文案仍保留（预检 + 兜底）。
 * @why 口径来源：`ADDRESS_PATTERNS.ascii` 与契约 `AddressInput.pattern`（`^[ -~]+$`，可打印 ASCII）——
 *      这是服务端会拒的硬约束，不是建议；理由是美国面单不接受全角 / 中日文（同上注释）。
 *      不写"海关要求"之类没有出处的说法；示例只用公开的美国地址书写惯例（门牌 + 街道在第一行，Apt / Suite 在第二行）。
 * @limitation 只是文案，不做自动转拼音（转写规则因人名而异，自动转错比让用户自己写更糟）。
 */
export const ENGLISH_ADDRESS_NOTE = {
  title: '请用英文 / 拼音填写',
  body: '地址会打印在美国面单上，派送只认英文字母、数字与半角符号，中文、日文或全角字符无法提交。',
  /** `value` 必须能通过本文件的校验（单测断言）：示例本身填不进去，说明就是错的。 */
  examples: [
    { key: 'recipient', label: '收件人', value: 'Xiaoming Wang', hint: '拼音即可' },
    { key: 'line1', label: '地址第一行', value: '1234 Market St', hint: '门牌号 + 街道' },
    { key: 'line2', label: '地址第二行', value: 'Apt 5B', hint: 'Apt / Suite 写这里，没有可留空' },
  ],
};

/** MVP 唯一目的国（@see @limitation 一）。 */
export const ADDRESS_COUNTRY_DEFAULT = 'US';

/**
 * 与契约 `AddressInput.pattern` **同源**的正则。
 *
 * ⚠️ 改这里要同时确认契约没改：`address-form.unit.test.ts` 用正则从 yaml 里抽出
 *    pattern 做双向比对，任一边改了另一边不跟进 → gate 变红。
 */
export const ADDRESS_PATTERNS = {
  /** `^[ -~]+$`：可打印 ASCII（美国地址面单不接受全角 / 日文）。 */
  ascii: /^[ -~]+$/,
  /** `^[ -~]*$`：同上但允许为空（`line2` 可省）。 */
  asciiOptional: /^[ -~]*$/,
  /** `^\+1[0-9]{10}$`：北美号码，带国家码。 */
  phone: /^\+1[0-9]{10}$/,
  /** `^\d{5}(-\d{4})?$`：5 位 ZIP 或 ZIP+4。 */
  postal: /^\d{5}(-\d{4})?$/,
  /** 州缩写（契约只约束长度 2；大小写由 @limitation 二 归一）。 */
  state: /^[A-Z]{2}$/,
};

/**
 * 各字段最大字符数（与服务端 `domain/address-input.ts` 的 `ADDRESS_MAX_CHARS`、表列宽一致）。
 * @why TST3-02：原来前端只查格式不查长度，超长的第二行地址要提交后才被服务端以 40001 拒掉，
 *      而用户看到的是一句笼统的请求错误。单测把这张表与服务端那张逐键比对，任一边改了另一边红。
 */
export const ADDRESS_MAX_CHARS = {
  recipient: 100,
  phone: 20,
  line1: 200,
  line2: 200,
  city: 100,
  postal_code: 10,
};

/** 表单字段（顺序 = 编辑页表单顺序；**不含** country/is_default，见 @limitation 一）。 */
export const ADDRESS_FIELDS = [
  'recipient',
  'phone',
  'line1',
  'line2',
  'city',
  'state',
  'postal_code',
];

/** 空表单（新增态）。 */
export function emptyForm() {
  return {
    recipient: '',
    phone: '',
    line1: '',
    line2: '',
    city: '',
    state: '',
    postal_code: '',
    is_default: false,
  };
}

/**
 * 服务端 `Address` → 表单模型（编辑态）。
 * @param {unknown} addr 服务端地址；null/undefined → 空表单
 * @why 逐字段取值而不是 `{...addr}`：地址对象是**外部输入**（可能多字段、可能缺字段），
 *      铺进去会把未知字段一路带到请求体里（服务端会 40001），而报错指向请求体不指向表单。
 */
export function formModel(addr) {
  const a = addr && typeof addr === 'object' ? addr : {};
  const text = (v) => (typeof v === 'string' ? v : '');
  return {
    recipient: text(a.recipient),
    phone: text(a.phone),
    line1: text(a.line1),
    line2: text(a.line2),
    city: text(a.city),
    // @see @limitation 二（州名大小写归一）
    state: text(a.state).toUpperCase(),
    postal_code: text(a.postal_code),
    is_default: a.is_default === true,
  };
}

/**
 * 美国电话的常见写法 → E.164（`+1` + 10 位，P2-37）。
 * @param {unknown} raw 用户输入
 * @returns {string} 认得出 → `+1XXXXXXXXXX`；认不出 → **原样 trim**（交给 `formErrors` 去拒，不猜）
 * @why 美国人写电话几乎从不带 `+1`：`(415) 555-0123`、`415-555-0123`、`1 415 555 0123` 都是日常写法。
 *      以前一律报"格式为 +1 开头"，用户得自己猜要删掉哪些括号横线——这是表单里最常见的卡点。
 * @why 只认两种数字形态：10 位（本地号）与 1 开头的 11 位（带国家码）；分隔符只认空格 ( ) - . 和开头一个 +。
 *      带 `+` 却不是 `+1`（外国号）、位数不对、夹了字母（ext 分机）——一律不动，由校验给出提示。
 * @limitation 只管美国（单一目的国，见 @limitation 一）；服务端规则 `^\+1\d{10}$` 不变，这里只是把输入凑成它。
 *              不校验区号合法性（NANP 首位不能是 0/1）：服务端也不校验，前端多拒一层会出现"前端拒、服务端收"。
 */
export function normalizeUsPhone(raw) {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!/^\+?[0-9 ().-]+$/.test(s)) return s;
  const digits = s.replace(/[^0-9]/g, '');
  const plus = s.startsWith('+');
  if (!plus && digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return s;
}

/**
 * 电话框的显示值（小程序评估 A12，2026-10-09）：电话框改用数字键盘后打不出 `+`，
 * 编辑已有地址时把存着的 `+1…` 去掉开头的 `+` 再放进框里；提交 / 校验时 `normalizeUsPhone` 会还原成 `+1…`。
 * @param {unknown} phone
 */
export function phoneForInput(phone) {
  return typeof phone === 'string' ? phone.replace(/^\+/, '') : '';
}

/**
 * 校验表单。
 * @param {unknown} model
 * @returns {{ok: boolean, errors: Record<string, string>, first: string}}
 *          `errors` 以字段名为键（wxml 可按字段显示），`first` 是第一条提示（弹 toast 用）
 * @why 返回**全部**错误而不是只返第一条：七字段表单一个一个报，用户要提交七次。
 *      `first` 另给一份是因为 toast 只能显示一句——两者不冲突。
 */
/**
 * 邮编首位数字（USPS 国家分区）→ 可能的州。只用来拦"明显选错州"，不做精确的邮编库。
 * @why 三端模拟测试 2026-10-11：州下拉误选成 NV、邮编是纽约的 10013，照样存上——面单写成 "New York, NV, 10013"。
 * @measured 2026-10-11 网页检索（zip-codes.com / USPS 分区表）：0 = CT MA ME NH NJ NY(仅 Fishers Island) PR RI VT VI + 军邮 AE；
 *           8 = AZ CO ID NM NV UT WY；与下表一致。
 * @limitation 例外只照顾已知的几处（纽约 06390 / 00501、得州 El Paso 885xx、华盛顿特区 569xx）；
 *             宁可少拦——表里多放一个州只是漏拦一种选错，少放一个就是合法地址存不上。
 */
const ZIP_AREA_STATES = [
  ['CT', 'MA', 'ME', 'NH', 'NJ', 'NY', 'PR', 'RI', 'VT', 'VI', 'AE'],
  ['DE', 'NY', 'PA'],
  ['DC', 'MD', 'NC', 'SC', 'VA', 'WV'],
  ['AL', 'FL', 'GA', 'MS', 'TN', 'AA'],
  ['IN', 'KY', 'MI', 'OH'],
  ['IA', 'MN', 'MT', 'ND', 'SD', 'WI', 'DC'],
  ['IL', 'KS', 'MO', 'NE'],
  ['AR', 'LA', 'OK', 'TX'],
  ['AZ', 'CO', 'ID', 'NM', 'NV', 'UT', 'WY', 'TX'],
  ['AK', 'CA', 'HI', 'OR', 'WA', 'AS', 'GU', 'MP', 'MH', 'FM', 'PW', 'AP'],
];

/** 邮编与州对得上吗（只看首位数字）。邮编或州形状不对时返回 true——那由各自的格式校验去报。 */
export function zipMatchesState(zip, state) {
  const d = /^(\d)\d{4}(-\d{4})?$/.exec(String(zip).trim());
  const st = String(state).trim().toUpperCase();
  if (d === null || !isUsStateCode(st)) return true;
  return ZIP_AREA_STATES[Number(d[1])].includes(st);
}

export function formErrors(model) {
  const m = formModel(model);
  const errors = {};
  // 三端模拟测试 2026-10-11（新用户首单）：空字段说"请填写"，填了中文 / 全角才说"请用英文"——
  //   原先一个字没写也提示"请用英文/数字填写"，用户以为是自己写错了格式
  const blank = (v) => v.trim() === '';
  if (blank(m.recipient)) errors.recipient = '请填写收件人姓名（英文，如 Ken Tanaka）';
  else if (!ADDRESS_PATTERNS.ascii.test(m.recipient.trim()))
    errors.recipient = '收件人请用英文/数字填写（面单不支持中文或全角）';
  // P2-37：先归一常见写法再校验（与 toAddressInput 发出去的是同一个值）
  const phoneBlank = blank(m.phone);
  m.phone = normalizeUsPhone(m.phone);
  if (phoneBlank) errors.phone = '请填写美国电话号码（10 位，如 4155550123）';
  else if (!ADDRESS_PATTERNS.phone.test(m.phone))
    // 统一结论 5.3：电话框是数字键盘（打不出「+」），只说能打出来的写法；+1 由 normalizeUsPhone 补
    errors.phone = '请填美国 10 位电话号码，如 4155550123（带国家码就是 1 开头 11 位）';
  if (blank(m.line1)) errors.line1 = '请填写街道地址（英文，如 350 5th Ave）';
  else if (!ADDRESS_PATTERNS.ascii.test(m.line1.trim()))
    errors.line1 = '地址第一行请用英文/数字填写';
  if (!ADDRESS_PATTERNS.asciiOptional.test(m.line2.trim()))
    errors.line2 = '地址第二行请用英文/数字填写（可留空）';
  if (blank(m.city)) errors.city = '请填写城市（英文，如 New York）';
  else if (!ADDRESS_PATTERNS.ascii.test(m.city.trim())) errors.city = '城市请用英文/数字填写';
  // 三端走查小白视角（2026-10-10）：州是下拉选择，没选时只说"请选择州"——"两位大写缩写"对用户是术语；
  // 形状不对只会来自旧数据，才保留原句
  if (m.state.trim() === '') errors.state = '请选择州';
  else if (!ADDRESS_PATTERNS.state.test(m.state.trim()))
    errors.state = '州为两位大写缩写，请从列表选择';
  // 剩余清单 4-5：两位大写还不够，必须是 USPS 真实州码（与服务端 address-input.ts 同口径）
  else if (!isUsStateCode(m.state.trim().toUpperCase()))
    errors.state = '请从列表选择州（这个州码不存在）';
  if (blank(m.postal_code)) errors.postal_code = '请填写邮编（5 位，如 94105）';
  else if (!ADDRESS_PATTERNS.postal.test(m.postal_code.trim()))
    errors.postal_code = '邮编为 5 位或 ZIP+4，如 94105 或 94105-1234';
  // 邮编与州各自合法、但对不上（多半是州下拉选错了）——报在邮编上，说清当前选的是哪个州
  if (
    errors.postal_code === undefined &&
    errors.state === undefined &&
    !zipMatchesState(m.postal_code, m.state)
  ) {
    const st = m.state.trim().toUpperCase();
    const name = US_STATE_ROWS.find((r) => r.code === st)?.name ?? st;
    errors.postal_code = `邮编 ${m.postal_code.trim()} 不属于 ${name}（${st}）——请检查州或邮编`;
  }
  for (const k of Object.keys(ADDRESS_MAX_CHARS)) {
    if (errors[k] === undefined && m[k].trim().length > ADDRESS_MAX_CHARS[k])
      errors[k] = `最多 ${ADDRESS_MAX_CHARS[k]} 个字符`;
  }
  const first = Object.values(errors)[0] ?? '';
  return { ok: Object.keys(errors).length === 0, errors, first };
}

/**
 * 表单模型 → 契约 `AddressInput` 请求体。
 * @why `line2` 空串仍**带上**而不是删掉：契约允许空串（`^[ -~]*$`），
 *      删掉字段会让"改地址时清空第二行"变成"第二行保持不变"——
 *      用户清了却没生效，且从 UI 上看不出区别。
 * @limitation 四：**不校验**（校验是 `formErrors` 的事，调用方先过一遍）。
 *              这里顺手校验的表现是"两个地方都能拒，但只有一个地方会提示"，
 *              而没提示的那个（这里）会静默吞掉提交。
 */
export function toAddressInput(model) {
  const m = formModel(model);
  return {
    recipient: m.recipient.trim(),
    // P2-37：发出去的是归一后的 E.164（服务端只认 ^\+1\d{10}$）
    phone: normalizeUsPhone(m.phone),
    line1: m.line1.trim(),
    line2: m.line2.trim(),
    city: m.city.trim(),
    state: m.state.trim().toUpperCase(),
    postal_code: m.postal_code.trim(),
    country: ADDRESS_COUNTRY_DEFAULT,
    is_default: m.is_default === true,
  };
}

/**
 * 地址 → 一行摘要（确认订单页 / 列表项副标题用）。
 * @returns {{recipient: string, phone: string, line1: string, line2: string, region: string}}
 * @why 摘要在**这里**拼而不是 wxml 里拼字符串：WXML 里做字符串拼接与空值判断
 *      会产出"San Francisco, , CA"这种双逗号，而它在真机上的样子就是"地址显示错了"。
 */
export function addressSummary(addr) {
  const a = addr && typeof addr === 'object' ? addr : {};
  const text = (v) => (typeof v === 'string' ? v.trim() : '');
  const region = [text(a.city), text(a.state), text(a.postal_code)].filter((s) => s !== '');
  return {
    recipient: text(a.recipient),
    phone: text(a.phone),
    line1: text(a.line1),
    line2: text(a.line2),
    region: region.join(', '),
  };
}

/**
 * 默认地址 id：`is_default` 优先，没有则取第一条；空列表 → 空串。
 * @why 确认订单页必须**预选一个**地址（否则每次下单都要多点一次），
 *      而"预选哪个"在两个页面各写一遍就会不一致（列表页认第一条、结算页认 is_default）。
 */
export function defaultAddressId(list) {
  if (!Array.isArray(list)) return '';
  const picked = list.find((a) => a && a.is_default === true && typeof a.id === 'string');
  if (picked !== undefined) return picked.id;
  const first = list.find((a) => a && typeof a.id === 'string');
  return first?.id ?? '';
}
