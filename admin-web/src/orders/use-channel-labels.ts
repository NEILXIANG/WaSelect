/**
 * 职责：取支付通道中文名的 React hook（整个页签只取一次设置接口，模块级缓存）。
 *
 * @why 从 channel-labels.ts 拆出：那边只留纯函数，供根目录测试直接调用而不把 React 类型带进根 tsc 程序
 *      （见 channel-labels.ts 文件头）。
 * @limitation 中文名改了要重启服务才生效（设置页写着），页签内不会变；取数失败给空表、下次进页面再试。
 */
import { useEffect, useState } from 'react';
import { getSettings, type AdminApi } from '../settings/api.js';
import { channelLabelsFrom, type ChannelLabels } from './channel-labels.js';

let cache: Promise<ChannelLabels> | null = null;

/** 测试用：清掉模块缓存。 */
export function resetChannelLabelCache(): void {
  cache = null;
}

/** 通道中文名（第一次调用取设置接口，之后用缓存；失败给空表）。 */
export function useChannelLabels(api: AdminApi): ChannelLabels {
  const [labels, setLabels] = useState<ChannelLabels>({});
  useEffect(() => {
    let alive = true;
    cache ??= getSettings(api)
      .then(channelLabelsFrom)
      .catch(() => {
        cache = null; // 失败不缓存，下次进页面再试
        return {};
      });
    void cache.then((l) => {
      if (alive) setLabels(l);
    });
    return () => {
      alive = false;
    };
  }, [api]);
  return labels;
}
