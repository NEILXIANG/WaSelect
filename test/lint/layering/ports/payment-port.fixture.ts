/**
 * 夹具：一个**端口**（接口定义）。端口层不依赖任何实现，也不依赖 domain。
 * @why 端口是"领域向外要能力"的声明处。它一旦 import 实现，依赖方向就反了，
 *      于是"换实现"这件事从改配置退化成改代码——那正是 F10 要防的。
 */
export interface PaymentProvider {
  readonly name: string;
  charge(input: { amountJpy: number }): Promise<{ ok: boolean }>;
}
