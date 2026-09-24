/**
 * 职责：`setupFiles` 的入口——**只做一件事**：把外网闸门装上。
 *
 * @why 单独成一个文件而不是让 `network-guard.ts` 自带副作用：
 *      若模块一被 import 就自安装，那么"闸门是否真的装上了"这个问题
 *      会被**任何 import 了它的测试文件**回答成"装上了"——包括那些只 import 了
 *      `isOutboundAllowed` 做纯判定的文件。那样 setupFiles 配没配对就没人知道。
 *      拆开之后：`network-guard.ts` 是纯能力，`install-network-guard.ts` 是安装动作，
 *      而"安装动作有没有被执行"由 `network-guard.unit.test.ts` 第一条断言盯住。
 *
 * @see ../vitest.config.mts（setupFiles）；./network-guard.ts（能力）
 */
import { installNetworkGuard } from './network-guard.js';

installNetworkGuard();
