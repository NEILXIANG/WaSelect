/**
 * 职责：行走骨架的演示页（F6c）——一个按钮走完「建单 → 模拟支付 → 状态回写」。
 *
 * @why 这一页存在的唯一目的是**证明全栈是通的**：真机上点一次，
 *      就能在服务端日志里按 trace_id 查到这一跳。它不是产品页面，
 *      业务期会由真实的商品/下单页取代——所以刻意做得极简，不做交互打磨。
 *
 * @limitation 一：**三次请求复用同一个 trace_id**（建单 / 模拟支付 / 刷新），
 *              这样服务端三行日志是同一条链。真实业务里"一次用户操作"的边界由页面决定，
 *              不是每个请求各建一个——各建一个会让日志永远串不起来。
 * @limitation 二：错误只做展示，不做重试与跳转。40101 的 action 是"静默重新登录并重放"，
 *              但重放需要重新取数，属页面业务，骨架期不做。
 * @limitation 三：幂等键只存在**页面实例的内存**里（@see utils/idempotency.js @limitation 一）。
 *              页面销毁重建会丢键，重试会被当作新意图——MVP 刻意接受，
 *              要修应落在服务端草稿单，而不是把键写进本地缓存。
 */
import { createIntentIdempotency } from '../../utils/idempotency.js';
import { newTraceId } from '../../utils/trace.js';

const app = getApp();

Page({
  data: {
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

  async onCreate() {
    // ⚠️ 必须自己挡连点：wxml 上的 `loading` 只让按钮转圈，**不会阻止 bindtap**，
    //    `disabled` 才会。不挡的话连点会发出两个并发请求；即便键相同，
    //    服务端也会让第二个拿 40903（"处理中"）而不是结果——体验上仍是"点了报个错"。
    if (this.data.loading) return;

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
