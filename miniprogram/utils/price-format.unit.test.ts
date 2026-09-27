/**
 * 职责：金额展示格式化的单测（F14 第一个基础组件的前置）。
 *
 * @why 格式化看着是"小事"，但它的错误形态是**静默且跨页面**的：
 *      `1234 円` 与 `1,234 円` 都能读，而"不同页面长得不一样"没有任何报错；
 *      `0 円` 与"不显示"之间隔着一整个"用户以为免费"的距离。
 *      所以三条边界必须各自有用例：千分位、四舍五入方向、坏数据必须响亮失败。
 *
 * @how 断言**具体字符串**而不是"包含数字"：包含式断言在少了分隔符时照样绿。
 */
import { describe, expect, it } from 'vitest';
import { displaySubLine, formatCnyFen, formatJpy, formatUsdCents } from './price-format.js';

describe('千分位', () => {
  it('四位数加一个分隔符', () => {
    expect(formatJpy(1234)).toBe('1,234 円');
  });

  it('整千位不加尾部空组（`1,000 円` 不是 `1,000, 円`）', () => {
    expect(formatJpy(1000)).toBe('1,000 円');
  });

  it('三位数不加分隔符', () => {
    expect(formatJpy(123)).toBe('123 円');
  });

  it('大金额每一组三个数字', () => {
    expect(formatJpy(12345678)).toBe('12,345,678 円');
  });

  it('0 → `0 円`（不是空串，也不是占位符）', () => {
    expect(formatJpy(0)).toBe('0 円');
  });
});

describe('负数（退款 / 折扣会真的出现负金额）', () => {
  it('负号在数字前面、单位在后（`-1,234 円`）', () => {
    expect(formatJpy(-1234)).toBe('-1,234 円');
  });

  it('-0 → `0 円`（不带负号：`-0 円` 看起来像出错了）', () => {
    expect(formatJpy(-0)).toBe('0 円');
  });

  /**
   * D-36（三审 A1）：三币并列、**符号不共用**——主行 `3,600 円`，副行才是 `≈ $24.50 · ≈ 人民币 ¥176`。
   * 旧实现输出 `¥1,234`：`¥` 正是 D-36 分配给**人民币**的符号，目标用户是美国华人，
   * 1,234 円 ≈ 60 元会被读成人民币 1,234 元（差 20 倍）；同一页再出现 `人民币 ¥176` 就是两个 ¥ 两种币。
   */
  it('D-36：日元不用 ¥，单位写 円（¥ 留给副行的人民币）', () => {
    expect(formatJpy(3600)).toBe('3,600 円');
    expect(formatJpy(3600)).not.toContain('¥');
  });
});

describe('非整数：响亮失败而不是四舍五入（三审 P3-4 / A5）', () => {
  /**
   * @why 旧实现以"含税价 ×1.1 会算出小数"为由做 Math.round——但出口件免消费税、`price_jpy`
   *      是整数锚（D-14），契约与技术文档规定 JPY 全链路整数、前端不做任何乘法（D-36）。
   *      API 若真返回 `1234.4`，是服务端 bug；静默入整会把它藏起来，与 NaN 同一条响亮失败通道才对。
   */
  it.each([1234.4, 1234.5, 0.1, -0.4])('%s → 抛错', (value) => {
    expect(() => formatJpy(value)).toThrow(/必须是整数/);
  });
});

describe('坏数据必须响亮失败（@limitation 一）', () => {
  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['undefined', undefined],
    ['null', null],
    ['字符串', '1234'],
    ['对象', {}],
  ])('%s → 抛错（不给默认值、不显示占位符）', (_name, value) => {
    // @why 静默给 `¥0` 的后果是"用户以为免费"；静默显示占位符的后果是"这个商品没有价格"。
    //      两者都比"组件渲染失败 + 控制台一条明确报错"贵。
    // ⚠️ 这里的强转是**刻意**的：该函数在运行时要能挡住任何类型，
    //    所以用例必须真的把非数字传进去——类型层面装作是数字，是为了把"运行时校验"测出来。
    expect(() => formatJpy(value as unknown as number)).toThrow(/金额必须是整数/);
  });
});

/**
 * I1-U7b：Display 展示价（后端算好的**整数分**）的前端格式化。
 * 前端不做汇率乘法（契约 Display schema / 文件头 @why），只把整数分拼成文案。
 */
describe('formatUsdCents / formatCnyFen（整数分 → 两位小数）', () => {
  it('分 → 元：小数恒两位（`$24.50` 不是 `$24.5`）', () => {
    expect(formatUsdCents(2450)).toBe('$24.50');
    expect(formatCnyFen(2450)).toBe('¥24.50');
  });

  it('不足一元：整数部分是 0（`$0.05`，不是 `$.05`）', () => {
    expect(formatUsdCents(5)).toBe('$0.05');
    expect(formatCnyFen(5)).toBe('¥0.05');
  });

  it('整元也带两位小数（`$1.00`：有没有小数位不能随金额变）', () => {
    expect(formatUsdCents(100)).toBe('$1.00');
    expect(formatCnyFen(100)).toBe('¥1.00');
  });

  it('整数部分千分位、小数部分不分组', () => {
    expect(formatUsdCents(123456)).toBe('$1,234.56');
    expect(formatCnyFen(123456789)).toBe('¥1,234,567.89');
  });

  it('0 → `$0.00` / `¥0.00`；-0 不带负号（0 没有方向）', () => {
    expect(formatUsdCents(0)).toBe('$0.00');
    expect(formatCnyFen(-0)).toBe('¥0.00');
  });

  it('负数（退款/折扣）：符号在最前（`-$24.50`）', () => {
    expect(formatUsdCents(-2450)).toBe('-$24.50');
    expect(formatCnyFen(-2450)).toBe('-¥24.50');
  });

  /**
   * D-36（三审 A1）：三币并列、**符号不共用**——円 是日元、`$` 是美元、`¥` 是人民币。
   * 目标用户是美国华人，`¥` 在他们眼里就是人民币；串了符号就是 20 倍的数量级误读。
   */
  it('D-36：美元用 $、人民币用 ¥，互不串符号', () => {
    expect(formatUsdCents(2450)).toBe('$24.50');
    expect(formatUsdCents(2450)).not.toContain('¥');
    expect(formatCnyFen(17600)).toBe('¥176.00');
    expect(formatCnyFen(17600)).not.toContain('$');
  });

  it.each([1234.4, 0.1, -0.4])(
    '非整数分 %s → 抛错（契约就是整数分，收到小数是服务端 bug）',
    (v) => {
      expect(() => formatUsdCents(v)).toThrow(/必须是整数分/);
      expect(() => formatCnyFen(v)).toThrow(/必须是整数分/);
    },
  );

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['null', null],
    ['字符串', '2450'],
  ])('坏数据 %s → 抛错（与 formatJpy 同一条响亮失败通道）', (_name, v) => {
    // ⚠️ 强转是刻意的：运行时校验必须真的被非数字触发（见上方 formatJpy 同组 @why）
    expect(() => formatUsdCents(v as unknown as number)).toThrow(/必须是整数分/);
    expect(() => formatCnyFen(v as unknown as number)).toThrow(/必须是整数分/);
  });
});

describe('displaySubLine（副行文案，D-36 三币口径的展示侧）', () => {
  it('USD + CNY 都在 → `≈ $… · ≈ ¥…`（首页卡片与详情页共用这一份）', () => {
    expect(displaySubLine({ USD: 2450, CNY: 17600 })).toBe('≈ $24.50 · ≈ ¥176.00');
  });

  it('缺一个币 → 只显示另一个（fx 缺失时 display 会少键，AJ-108 降级口径）', () => {
    expect(displaySubLine({ USD: 2450 })).toBe('≈ $24.50');
    expect(displaySubLine({ CNY: 17600 })).toBe('≈ ¥176.00');
  });

  it('⚠️ 非整数跳过该币而**不抛**：浏览页抛会让整页渲染失败，比少一行参考价贵', () => {
    // @why 服务端返回小数是服务端 bug，由契约测试与日志去暴露，不由首页 UI 承担。
    expect(displaySubLine({ USD: 24.5, CNY: 17600 })).toBe('≈ ¥176.00');
  });

  it('空对象 / 缺失 / 形态不对 → 空串（调用方用 wx:if 整行隐藏，不留孤零零一个 ≈）', () => {
    for (const d of [{}, undefined, null, 'x', 0]) {
      expect(displaySubLine(d)).toBe('');
    }
  });

  it('0 分也显示（`$0.00` 是真实换算结果，不是缺失——缺失走的是"没有键"那条路）', () => {
    expect(displaySubLine({ USD: 0, CNY: 0 })).toBe('≈ $0.00 · ≈ ¥0.00');
  });
});
