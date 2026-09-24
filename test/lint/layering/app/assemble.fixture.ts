/**
 * 夹具：**合法**的组装层——只有 app 可以同时 import domain 与 adapters。
 * @why 组装层是唯一"知道全部具体实现"的地方。把它钉成合法，
 *      等于钉住"依赖注入只发生在一处"这条约定。
 */
import { stripeish } from '../adapters/stripe-adapter.fixture.js';
import { providerName } from '../domain/pricing.fixture.js';

export const wired = providerName(stripeish);
