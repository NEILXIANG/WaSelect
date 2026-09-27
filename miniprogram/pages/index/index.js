/**
 * 职责：行走骨架的演示页（F6c）——一个按钮走完「建单 → 模拟支付 → 状态回写」。
 *
 * ⚠️ **本页已停用**：它调用的 `/api/v1/skeleton/*` 端点已随 U6c 骨架退役删除。
 *    停用形态是**按钮禁用 + 页首明示原因**（`retired`，见 index.wxml），
 *    而不是留三个点了必然 404 的按钮——"看起来能用、实际是坏的"比明确停用贵得多。
 *
 * @why **为什么不改成真实业务路径**（I2 欠账，此处说清理由，避免被当成"忘了改"）：
 *      本页的按钮 2 是「触发模拟支付回调」，而真实链路里回调由**机构**发起、
 *      带服务端密钥签名——前端既做不到、也不该做（能伪造回调 = 能伪造"已付款"）。
 *      于是"一键走完建单→支付→回写"这个演示用途**在骨架退役后无法用真实端点复现**；
 *      接真实路径等于新写一个下单页（登录/地址/选 SKU/发起支付），那是 I2 的正经工作。
 *      @limitation 五：真要动它，先补**前端页面级的验证手段**（当前小程序页面无任何
 *      自动化测试，改完只能人工真机点）——按 CLAUDE.md 约束一，无绿灯证据不前进。
 *      在补上验证手段之前，本页的正确形态就是"明确停用 + 指路 e2e"。
 *
 * @why 这一页存在的唯一目的是**证明全栈是通的**：真机上点一次，
 *      就能在服务端日志里按 trace_id 查到这一跳。该职责已由
 *      `test/e2e/miniprogram-shell.e2e.test.ts` 接手（真实业务链路，五跳共用一条 trace），
 *      所以本页现在只剩"ws-button / 幂等键 / trace 串联的写法参考"这一个价值。
 *
 * @limitation 一：**三次请求复用同一个 trace_id**（建单 / 模拟支付 / 刷新），
 *              这样服务端三行日志是同一条链。真实业务里"一次用户操作"的边界由页面决定，
 *              不是每个请求各建一个——各建一个会让日志永远串不起来。
 * @limitation 二：错误只做展示，不做重试与跳转。40101 的 action 是"静默重新登录并重放"，
 *              但重放需要重新取数，属页面业务，骨架期不做。
 * @limitation 三：幂等键只存在**页面实例的内存**里（@see utils/idempotency.js @limitation 一）。
 *              页面销毁重建会丢键，重试会被当作新意图——MVP 刻意接受，
 *              要修应落在服务端草稿单，而不是把键写进本地缓存。
 * @limitation 四：按钮统一走 `ws-button`，"处理中别再点"这道防线**只在组件里**有一份
 *              （@see ../../components/ws-button/index.js @why）。页面里刻意**不写**手写守卫——
 *              有守卫反而说明组件那道没起作用，或迟早变成两处规则各自漂移。
 *              @see ../page-button-guard.unit.test.ts（这两条规则由机器守着）
 */
import { createIntentIdempotency } from '../../utils/idempotency.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

Page({
  data: {
    /**
     * true = 本页停用（骨架端点已删）。
     * @why 它是**数据**而不是常量：wxml 用它控制按钮 disabled 与页首提示，
     *      js 的三个 handler 也读它做守卫——一份开关，两处生效，不会出现
     *      "按钮灰了但直接调方法还能发出请求"的缝。
     */
    retired: true,
    token: '',
    orderId: '',
    orderNo: '',
    status: '',
    traceId: '',
    error: '',
    loading: false,
    /** true = 本次建单沿用了上次未完成的幂等键（即这是一次重试），仅用于骨架页上肉眼可见。 */
    retrying: false,
  },

  onLoad() {
    this.setData({ token: app.globalData.token });
    // ⚠️ 建在这里而不是模块顶层：① 页面每次进入都是新意图；
    //    ② 多实例（navigateTo 多次）不会共用一个键。
    this.intentKey = createIntentIdempotency();
  },

  onTokenInput(e) {
    const value = e.detail.value;
    app.setToken(value);
    this.setData({ token: value });
    // 换了用户 = 换了意图：旧键必须作废，否则新用户沿用旧键会拿到旧用户那张单的重放结果
    // （服务端 scopeKey 含 user_id，不会串号，但客户端这一步仍要做，避免"我明明换了号却看到同一张单"）
    this.intentKey?.retire();
  },

  /** 统一收敛：把 ApiError 的 code+message 显示出来（code 可机读，便于对照错误码表）。 */
  showError(e) {
    const code = typeof e?.code === 'number' ? e.code : '';
    this.setData({ error: `${code} ${e?.message ?? '未知错误'}`.trim() });
  },

  /**
   * 建单。
   *
   * ⚠️ 这里**没有**连点守卫，也不是漏了：三个按钮都换成了 `ws-button`，
   *    那道防线只有组件里那一份（原生 `loading` 只转圈、不挡点击，
   *    `disabled` 才挡——而"处理中"期间按钮 1 走 `loading`、按钮 2/3 走 `disabled`）。
   *    @why 防线放两处的代价不是重复，而是**其中一处迟早被改掉而没人发现**：
   *    漏一个页面就是两条并发请求（连点建两张单，不报错但很贵）。
   *    @see ../../components/ws-button/index.js @why；page-button-guard.unit.test.ts（防它复发）
   */
  async onCreate() {
    // 停用守卫：wxml 那道 disabled 只挡 UI，这里挡"绕过 UI 直接调方法"
    if (this.data.retired) return;
    // 一次用户操作 = 一条链路：这里建一次，后续请求沿用
    const traceId = newTraceId();
    // 一次用户意图 = 一个幂等键：首次新建，**失败后沿用**，成功后作废。
    // 曾经的写法是 `mp-${Date.now()}`，等于每次点击都是新键 → 连点/重试会建出多张单。
    const { key, isRetry } = this.intentKey.acquire();
    this.setData({ loading: true, error: '', traceId, retrying: isRetry });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/skeleton/orders`,
        method: 'POST',
        data: {},
        idempotencyKey: key,
        traceId,
      });
      this.setData({
        orderId: res.order_id,
        orderNo: res.order_no,
        status: res.status,
      });
      // 成功 = 这次意图结束；键作废，下次点击是真正的"再建一张新单"
      this.intentKey.retire();
    } catch (e) {
      // 失败**不** retire：键留着，用户再点就是重试，服务端认得出是同一个意图
      this.showError(e);
    } finally {
      this.setData({ loading: false });
    }
  },

  async onSimulate() {
    if (this.data.retired) return;
    const { orderId, traceId } = this.data;
    if (!orderId) return;
    this.setData({ loading: true, error: '' });
    try {
      await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/skeleton/orders/${orderId}/simulate-paid`,
        method: 'POST',
        traceId,
      });
      await this.refresh(traceId);
    } catch (e) {
      this.showError(e);
    } finally {
      this.setData({ loading: false });
    }
  },

  async onRefresh() {
    if (this.data.retired) return;
    const { orderId, traceId } = this.data;
    if (!orderId) return;
    try {
      await this.refresh(traceId || newTraceId());
    } catch (e) {
      this.showError(e);
    }
  },

  async refresh(traceId) {
    const res = await app.globalData.api({
      url: `${app.globalData.apiBase}/api/v1/skeleton/orders/${this.data.orderId}`,
      traceId,
    });
    this.setData({ status: res.status });
  },
});
