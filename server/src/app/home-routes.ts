/**
 * 职责：买家侧首页聚合（D-51）——`GET /home`：**免鉴权**，一次返回
 *      「此刻生效的 Banner」+「分类清单」两块首页首屏要用的数据。
 *
 * @why 这两块合成一个端点而不是让首页打两次（`/banners` + 分类常量前端自带）：
 *      它们都是**首屏首帧**要用的，小程序一个请求一次往返（弱网下 300ms+）。
 *      分成两个的代价是首屏要么等两次、要么先出一半——而"先出商品流、banner 后补"
 *      在真机上是列表往上顶一下，属于用户能看见的抖动。
 *
 * @why `categories` 取 shared 的 `PRODUCT_CATEGORY`，**不查库里"有货的分类"**：
 *      契约里它是**分类清单**，不是库存概览。按库里有没有货来出，分类栏会随商品
 *      上下架**跳动**——用户第二次进来发现少了一个 tab，只会觉得这个站不稳定。
 *      更要紧的是 `GET /products?category` 的合法性校验用的**也是**这份枚举：
 *      两边不一致就会出现"tab 上有这个分类、点下去 40001"，且不报错。
 *      （这份枚举由 `packages/shared/src/enums.unit.test.ts` 与契约文本双向比对守着。）
 *
 * @why 生效判定（`active` + 起止时间窗）**只在本端点做一次**，前端不得自行再判：
 *      与 `FxRate.is_current` 同一条口径——"此刻生效吗"是**服务端时钟**的事实，
 *      前端拿本机时钟再判一次，时钟偏的用户会看到"该下架的还在 / 该上线的没来"，
 *      而这在真机上表现为随机的，没人会往时钟方向查。
 *
 * @limitation 一：**失败就让前端看见失败**（`next(e)`），不降级成 `{banners: []}`。
 *              空数组与"取不到"在页面上是同一个样子（没有 banner 段），
 *              吞成空数组等于把一次 DB 故障伪装成"今天没配 banner"——
 *              运营会去查 banner 配置，永远查不到。前端侧把 banner 的失败
 *              与商品流分开处理（只丢 banner 段），那是**前端**该做的降级，不在这里。
 * @limitation 二：banner **不分页、不限条数**。它是运营手工维护的量级（个位数），
 *              分页是为"可能很多"准备的；加了分页参数就要有默认值、上限、
 *              以及"首页该传几"的第二个决定——三个决定换一个不存在的问题。
 *
 * @why 挂载时 `IMG_BASE_URL` 未配置就打一条 **warn**（不是每次请求打）：
 *      那条链路上有一个**完全静默**的故障——配置没配 ⇒ 响应不带 `image`
 *      ⇒ 前端整条不展示（`banner-view.ts` @limitation 一）⇒ 页面上只是"没有轮播"，
 *      与"今天没配 banner"一模一样。**没有任何一方报错**：
 *      服务端是 200、小程序不给提示、运营在后台看得见自己配的那条 banner。
 *      启动日志是这条链路上唯一能让运维看见的地方，所以它必须在挂载期打、
 *      且只打一次（每次请求都打的话，首页每进一次屏就多一条噪音，
 *      真出事时它已经被淹没了）。
 *
 * @see adapters/banners.ts（生效判定）；./banner-view.ts（行 → 契约 Banner）；
 *      contracts/api-contract.yaml（/home）
 */
import type { Express } from 'express';
import type { Db } from '../adapters/db.js';
import type { Clock } from '../ports/clock.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';
import { createBannersRepo } from '../adapters/banners.js';
import { PRODUCT_CATEGORY } from '@waselect/shared';
import { toBannerView } from './banner-view.js';

export interface HomeRoutesDeps {
  db: Db;
  clock: Clock;
  config: AppConfig;
  logger: Logger;
}

export function mountHomeRoutes(app: Express, deps: HomeRoutesDeps): void {
  // ⚠️ @why 见文件头最后一条：这是"配了 banner 却永远不显示"唯一的可见入口
  if (deps.config.IMG_BASE_URL === undefined) {
    deps.logger.warn('home_image_base_unset', {
      result: 'skipped',
      ctx: { reason: 'IMG_BASE_URL 未配置：/home 的 banner 不带 image，小程序首页不展示轮播' },
    });
  }

  const banners = createBannersRepo(deps.db);

  app.get('/api/v1/home', (_req, res, next) => {
    void (async () => {
      try {
        // ⚠️ 时间来自注入的 clock（F10）："到点自动下架"必须是可测的确定量
        const rows = await banners.listActiveBanners(deps.clock.now());
        res.json({
          banners: rows.map((r) => toBannerView(r, deps.config.IMG_BASE_URL)),
          categories: [...PRODUCT_CATEGORY],
        });
      } catch (e) {
        next(e);
      }
    })();
  });
}
