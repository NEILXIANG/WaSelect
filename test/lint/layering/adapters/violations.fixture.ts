/**
 * 夹具：**违规**的适配器代码——adapters 反向依赖了 app（组装层）。
 * @why 适配器被组装层选用，它不能反过来知道"谁在用它"：
 *      否则删掉一个适配器就要改 app，新增一个通道也要改 app 之外的东西，
 *      "注册即接入"就没了。
 */
// eslint-disable-next-line no-restricted-imports
import type { AppToken } from '../app/app-token.fixture.js';

export type AdapterLeak = AppToken;
