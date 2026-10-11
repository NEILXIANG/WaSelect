/**
 * 联系邮箱形状的判例表（MP-9，AJ-479）：共享判据与小程序镜像跑同一张表，任何一边改了另一边红。
 * 每条写"为什么真实世界有这种输入"。
 */
export const EMAIL_SHAPE_CASES: ReadonlyArray<readonly [string, boolean, string]> = [
  ['jane@example.com', true, '最常见形态'],
  ['j.doe+tag@mail.example.co.jp', true, '点号、加号子地址、多级域名（日本运营商邮箱）'],
  ['li.wei@163.com', true, '国内邮箱，域名首段是数字'],
  ['user@xn--fiqs8s.cn', true, '国际化域名的 punycode 形态'],
  ['用户@例子.中国', true, '国际化邮箱（UTF-8 本地部分与域名），不靠正则拒非 ASCII'],
  ['a@b', false, '漏了域名后缀（手滑 / 只填了公司内网名）'],
  [
    'jane@localhost',
    false,
    '没有后缀的主机名（内网 / 测试环境地址；单段且 ≥ 2 字符，只有"必须有点"能拦）',
  ],
  ['x@b..com', false, '连点：输入法联想或手抖'],
  ['x@.b.com', false, '点开头的域名'],
  ['x@b.com.', false, '点结尾（句号被一起粘贴进来）'],
  ['x@b.c', false, '顶级域只有 1 个字符（不存在）'],
  ['x@b.123', false, '纯数字顶级域（多半是把 IP / 电话粘进来）'],
  ['a@b@c.com', false, '两个 @（把两个地址连在一起粘贴）'],
  ['ja ne@example.com', false, '中间有空格'],
  ['jane@exa mple.com', false, '域名里有空格'],
  ['jane\u3000@example.com', false, '全角空格（中文输入法下常见）'],
  ['@example.com', false, '没有本地部分'],
  ['jane@', false, '没有域名'],
  ['', false, '空串'],
  ['a\u0000@b.com', false, 'NUL：PG 拒收 0x00（ORD3-04）'],
  ['a@b.co\u0007', false, '控制字符：PG 会收下并入库（ORD3-04）'],
  [`${'a'.repeat(250)}@x.com`, false, '256 字符：超过 VARCHAR(255)'],
];
