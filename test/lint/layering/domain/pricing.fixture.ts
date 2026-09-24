/**
 * 夹具：**合法**的领域代码——只依赖 ports，不碰任何实现。
 * @why 这类文件存在的意义是证明"规则没有过度拦截"：只断言"违规会被报"的门禁
 *      会被一条"禁止一切 import"的规则轻松骗过。合法路径必须有自己的断言。
 */
import type { PaymentProvider } from '../ports/payment-port.fixture.js';

export function providerName(p: PaymentProvider): string {
  return p.name;
}
