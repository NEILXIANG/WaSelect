/**
 * 夹具：**违规**的端口代码——ports 反向依赖了 adapters / domain / app。
 * @why ports 一旦 import domain，就与"domain → ports"形成环：
 *      环不会立刻报错，但会让"换一个实现"变成"先解开一坨互相 import"，
 *      而且 TypeScript 的循环引用在运行时可能拿到 undefined（取决于求值顺序）。
 */
// eslint-disable-next-line no-restricted-imports
import type { stripeish } from '../adapters/stripe-adapter.fixture.js';
// eslint-disable-next-line no-restricted-imports
import type { DomainLeaks } from '../domain/violations.fixture.js';
// eslint-disable-next-line no-restricted-imports
import type { AppToken } from '../app/app-token.fixture.js';

export type PortLeaks = [typeof stripeish, DomainLeaks, AppToken];
