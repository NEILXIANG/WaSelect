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
 */
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
  },

  onLoad() {
    this.setData({ token: app.globalData.token });
  },

  onTokenInput(e) {
    const value = e.detail.value;
    app.setToken(value);
    this.setData({ token: value });
  },

  /** 统一收敛：把 ApiError 的 code+message 显示出来（code 可机读，便于对照错误码表）。 */
  showError(e) {
    const code = typeof e?.code === 'number' ? e.code : '';
    this.setData({ error: `${code} ${e?.message ?? '未知错误'}`.trim() });
  },

  async onCreate() {
    // 一次用户操作 = 一条链路：这里建一次，后续请求沿用
    const traceId = newTraceId();
    this.setData({ loading: true, error: '', traceId });
    try {
      const res = await app.globalData.api({
        url: `${app.globalData.apiBase}/api/v1/skeleton/orders`,
        method: 'POST',
        data: {},
        idempotencyKey: `mp-${Date.now()}`,
        traceId,
      });
      this.setData({
        orderId: res.order_id,
        orderNo: res.order_no,
        status: res.status,
      });
    } catch (e) {
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
