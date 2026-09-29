/**
 * 职责：支付通道**注册表**（F11 / ADR-28）——把"通道名 → 实现"这件事收在一处，
 *       让业务侧只问"有哪些通道可用"，而不是"这个字符串是哪家机构"。
 *
 * @why 放在 `adapters/`：注册表要**知道**具体工厂（谁实现了什么），
 *      它本身是装配的一部分；业务只见 `ports/payment.ts` 的 `PaymentRegistry` 接口。
 *
 * @why **配置是唯一开关**（E-2）：注册表里"没配置的通道 = 不开放"，
 *      即使代码注册了工厂也不开放。反过来，配置里写了但没注册工厂的通道**静默跳过**
 *      ——这不是宽容，而是有意的：配置可以比代码先行（先关掉、后删代码），
 *      否则"配置里留着旧通道名"会让服务起不来，而删配置与删代码的节奏本就不同步。
 *
 * @limitation 一：配置在**构造时**注入，运行时改配置需要重建注册表（进程重启）。
 *              @upgrade `payment_channels` 表落地后，把 `configs` 换成仓储查询即可，
 *              届时 `listAvailable` 会变成 async——**这是一次有意为之的局部破坏**，
 *              影响面只有 `/pay/channels` 与下单选通道两处调用点，不需要动 Provider。
 * @limitation 二：**不做**路由策略（成功率最优 / 成本最优）。当前只按 `priority` 排序，
 *              因为"最优"需要数据（成功率、费率），MVP 没有；强行写只会写出一个假的排序键。
 * @limitation 三：Provider 实例**按通道缓存**。所以工厂必须是纯装配（不含每次请求的状态），
 *              把"每次请求都变的东西"（如当前用户）放进 `PaymentRequest`，不要放进工厂闭包。
 *
 * @see ../../ports/payment.ts（契约与全部设计理由）；
 *      docs/可扩展架构设计-支付可插拔·多国家·UI可配置.md §2.2
 */
import {
  channelUnavailable,
  isChannelAvailable,
  type ChannelConfig,
  type ChannelQuery,
  type ChannelView,
  type PaymentProvider,
  type PaymentRegistry,
  type ProviderFactory,
} from '../../ports/payment.js';

export interface RegistryOptions {
  /** 通道配置（运营开关）。**顺序无关**：排序按 `priority`。 */
  configs: readonly ChannelConfig[];
}

export function createPaymentRegistry(opts: RegistryOptions): PaymentRegistry {
  /** 通道名 → 工厂（装配处逐个 register）。 */
  const factories = new Map<string, ProviderFactory>();
  /** 通道名 → 配置。 */
  const configs = new Map<string, ChannelConfig>();
  /** 通道名 → 已构造的实例（见 @limitation 三）。 */
  const instances = new Map<string, PaymentProvider>();

  for (const cfg of opts.configs) {
    if (configs.has(cfg.channel)) {
      // 装配期错误必须炸：两条同名配置会让"到底哪条生效"无法回答
      throw new Error(`payment_channels 配置重复：${cfg.channel}`);
    }
    configs.set(cfg.channel, cfg);
  }

  /**
   * 声明与实现的一致性。
   *
   * @why 能力是**自报**的（E-3），自报就可能说谎。最危险的一句是
   *      `supportsRefund: true` 而 `refund` 没实现——业务按声明调用，
   *      "客服点了退款"这条路径在运行时才炸，而那时钱已经收了。
   *      让它在**注册时**炸，是这类错误最便宜的暴露点。
   */
  function assertConsistent(provider: PaymentProvider, channel: string, cfg: ChannelConfig): void {
    if (provider.channel !== channel) {
      throw new Error(
        `Provider 自报的 channel 与注册键不一致：注册为 ${channel}，实例是 ${provider.channel}`,
      );
    }
    const cap = provider.capabilities.supportsRefund;
    const impl = provider.refund !== undefined;
    if (cap && !impl) {
      throw new Error(`通道 ${channel} 声明 supportsRefund 但没有实现 refund()`);
    }
    // F-03（AJ-178）：能退就必须能查——机构回 pending 的退款只有靠查询才走得出 refunding
    if (cap && provider.refundStatus === undefined) {
      throw new Error(`通道 ${channel} 声明 supportsRefund 但没有实现 refundStatus()`);
    }
    if (!cap && (impl || provider.refundStatus !== undefined)) {
      throw new Error(
        `通道 ${channel} 实现了 refund()/refundStatus() 却声明 supportsRefund=false（调用方不会调它）`,
      );
    }
    // ⚠️ 配置声明的币种必须是能力声明的子集（二次审查 P3-2）：两层开关的语义是
    //    "我们开不开（配置）∩ 机构做不做得到（能力）"——配置超出能力的部分会在
    //    `listAvailable` 里**静默不出现**（过滤掉了），排障时看起来像通道丢了。
    //    两侧都写 '*' 时跳过（'*' 的语义本来就是"不限"，谈不上子集）。
    const declared = cfg.currencies;
    const supported = provider.capabilities.currencies;
    if (!declared.includes('*') && !supported.includes('*')) {
      const over = declared.filter((c) => !supported.includes(c));
      if (over.length > 0) {
        throw new Error(
          `通道 ${channel} 配置声明的币种超出能力声明：${over.join(', ')}（配置 [${declared.join(', ')}] ⊄ 能力 [${supported.join(', ')}]）`,
        );
      }
    }
  }

  /** 取（或首次构造）实例；未注册工厂 → undefined（配置先行，静默跳过）。 */
  function resolve(channel: string): PaymentProvider | undefined {
    const cached = instances.get(channel);
    if (cached !== undefined) return cached;
    const factory = factories.get(channel);
    const cfg = configs.get(channel);
    if (factory === undefined || cfg === undefined) return undefined;
    const provider = factory(cfg);
    assertConsistent(provider, channel, cfg);
    instances.set(channel, provider);
    return provider;
  }

  return {
    register(channel, factory) {
      if (channel.length === 0) throw new Error('register：通道名不能为空');
      // ⚠️ 通道名会进 `webhook_events.provider`（VARCHAR(16)，migrations/003）：超长名字
      //    能注册成功，但回调登记时 22001 炸成 500——把长度闸在注册期（二次审查 P3-9）。
      if (channel.length > 16) {
        throw new Error(
          `register：通道名超过 16 字符（webhook_events.provider 列宽上限）：${channel}`,
        );
      }
      if (factories.has(channel)) {
        // 静默覆盖会让"线上生效的是哪个实现"变成谜，且只在出事后才被追问
        throw new Error(`重复注册支付通道：${channel}`);
      }
      factories.set(channel, factory);
      // 已缓存的实例立刻失效：注册顺序可能与首次取用交错
      instances.delete(channel);
    },

    get(channel) {
      const cfg = configs.get(channel);
      if (cfg === undefined) throw channelUnavailable(channel, 'channel_not_configured');
      if (!cfg.enabled) throw channelUnavailable(channel, 'channel_disabled');
      const provider = resolve(channel);
      if (provider === undefined) throw channelUnavailable(channel, 'channel_not_registered');
      return provider;
    },

    getForRefund(channel) {
      const cfg = configs.get(channel);
      if (cfg === undefined) throw channelUnavailable(channel, 'channel_not_configured');
      const provider = resolve(channel);
      if (provider === undefined) throw channelUnavailable(channel, 'channel_not_registered');
      // ⚠️ 这里是"下线语义"的全部：**禁用只影响新单，不影响老单退款**
      if (!cfg.enabled && !provider.capabilities.refundableWhenDisabled) {
        throw channelUnavailable(channel, 'channel_disabled_and_not_refundable');
      }
      if (provider.refund === undefined) {
        throw channelUnavailable(channel, 'refund_not_supported');
      }
      return provider;
    },

    /**
     * ⚠️ 这里**刻意不判 `enabled`**：见端口上 `getForCallback` 的 @why。
     *    与 `getForRefund` 的差别只有一处——它还要看 `refundableWhenDisabled`，这里不看；
     *    因为那条能力声明说的是"退款"，管不到"已经付成功的通知"。
     */
    getForCallback(channel) {
      const cfg = configs.get(channel);
      if (cfg === undefined) throw channelUnavailable(channel, 'channel_not_configured');
      const provider = resolve(channel);
      if (provider === undefined) throw channelUnavailable(channel, 'channel_not_registered');
      return provider;
    },

    listAvailable(query: ChannelQuery): ChannelView[] {
      const out: Array<{ view: ChannelView; priority: number; channel: string }> = [];
      for (const cfg of configs.values()) {
        // ⚠️ 这里的 `enabled` 判断与 `isChannelAvailable` 里那条是**同一个意思**，
        //    刻意保留两处：放在前面是为了**不构造**已禁用通道的 Provider——
        //    通道被禁用往往正是因为它的配置不全（密钥缺失），此时工厂可能直接抛错，
        //    而在"列出可用通道"这种只读路径上抛错，会让一个坏通道拖垮整个支付入口列表。
        //    ⚠️ 代价：两处必须一致。**规则语义只写在 `isChannelAvailable`**，
        //    这里只是早退——改规则改那边，别在这边加条件。
        if (!cfg.enabled) continue;
        const provider = resolve(cfg.channel);
        if (provider === undefined) continue; // 配置先行：未注册工厂 = 不开放
        if (!isChannelAvailable(cfg, provider.capabilities, query)) continue;
        out.push({
          view: {
            channel: cfg.channel,
            entryMode: provider.capabilities.entryMode,
            label: cfg.label,
            ...(cfg.icon !== undefined ? { icon: cfg.icon } : {}),
          },
          priority: cfg.priority,
          channel: cfg.channel,
        });
      }
      // 稳定排序：priority 相同时按 channel 字典序——否则同一份配置在不同引擎下顺序不同，
      // 表现为"支付入口顺序偶尔变一下"，而它其实来自 Map 迭代顺序与排序算法的稳定性
      out.sort((a, b) => a.priority - b.priority || a.channel.localeCompare(b.channel));
      return out.map((x) => x.view);
    },
  };
}
