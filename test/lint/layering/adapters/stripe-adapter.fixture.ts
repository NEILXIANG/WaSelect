/**
 * 夹具：**合法**的适配器——实现端口，可被 app 组装。
 */
import type { PaymentProvider } from '../ports/payment-port.fixture.js';

export const stripeish: PaymentProvider = {
  name: 'stripe',
  charge: async () => ({ ok: true }),
};
