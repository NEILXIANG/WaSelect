/**
 * 夹具：**违规**的领域代码——domain 反向依赖了 adapters / app，并直接 import 框架与驱动。
 *
 * @why 这些违规都用**内联 disable** 压住，所以 `npm run lint` 保持绿；
 *      真正的断言在 `test/lint/layering.lint.test.ts`，它读 `suppressedMessages`
 *      确认规则**确实报了**（与 A5 的类型感知夹具同一套路）。
 * @why 全部写成 `import type`：类型导入在编译后消失，
 *      于是这份夹具不会给产物引入任何真实依赖，也不可能被谁不小心执行。
 */
// eslint-disable-next-line no-restricted-imports
import type { stripeish } from '../adapters/stripe-adapter.fixture.js';
// eslint-disable-next-line no-restricted-imports
import type { AppToken } from '../app/app-token.fixture.js';
// eslint-disable-next-line no-restricted-imports
import type { Request } from 'express';
// eslint-disable-next-line no-restricted-imports
import type { Sql } from 'postgres';

export type DomainLeaks = [typeof stripeish, AppToken, Request, Sql];
