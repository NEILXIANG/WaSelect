/**
 * 职责：我的地址 CRUD（I1-U5a）——`GET/POST /addresses`、`PUT/DELETE /addresses/{id}`。
 *
 * 校验分层（与契约 AddressInput 逐条对齐，也与 DB CHECK 同源）：
 *   - **40001**（形状）：必填缺失 / 类型错 / 超长（VARCHAR 列宽）；
 *   - **40002**（格式）：非 ASCII（收件人/街道/城市须英文或拼音）、电话/邮编/state 格式、
 *     国家非可下单目的国。40002 的 action 是"表单提示"，所有"用户改一改就能对"的错都归它。
 *
 * @why 国家校验是**表驱动**（country_profiles.active）而不是写死 'US'：
 *      ADR-28"业务核心不认识任何国家"在写路径上的兑现——上线新目的国 = 表里加一行，
 *      本文件不改。country 省略时默认 'US'（契约 AddressInput.country default）。
 *
 * @why 归属不符一律 40400 而不是 40301：防存在性探测——40301 会告诉攻击者
 *      "这单存在但不是你的"，40400 则与"不存在"无法区分（与 order-query-routes 同口径）；
 *      仓储层已把 user_id 进 WHERE（addresses.ts @why）。
 *
 * @why 形状与格式的校验**不写在本文件**（U-B2c 起提到 `domain/address-input.ts`）：
 *      管理端改址收的是同一个 `AddressInput`，抄第二份就会各自漂移。
 *      本文件只补它做不了的一步——国家要查 `country_profiles`（有 I/O，留在路由层）。
 *
 * @limitation 一：PUT 是全量替换语义（契约 AddressInput 全字段），不做 PATCH。
 * @limitation 二：地址 CRUD 暂不挂限流——它是低频本人写路径（攻击面在登录/报价/短链）；
 *              真出现脚本刷地址时再按 rateLimitRules 表加规则（规则表是唯一出处）。
 *
 * @see contracts/api-contract.yaml（AddressInput/Address）；domain/address-input.ts（形状与格式校验）；
 *      adapters/addresses.ts；migrations/001_init.sql（CHECK 同源）+ 011（默认唯一索引）
 */
import type { Express } from 'express';
import { AppError } from '../errors.js';
import type { Logger } from '../logger.js';
import type { Db } from '../adapters/db.js';
import { requireRole, type AuthConfig } from './auth.js';
import type { IdentityCheck } from '../adapters/identity.js';
import { createAddressRepo, type AddressInput } from '../adapters/addresses.js';
import { createCountryProfileRepo } from '../adapters/country-profiles.js';
import type { IdGen } from '../ports/ids.js';
import { paramId } from '../http.js';
import { parseAddressInput } from '../domain/address-input.js';

export interface AddressRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  /**
   * 身份状态查询（D25）。**必填**——曾经是可选的，于是"路由忘了传"是能编译通过的，
   * 后果是封禁 / 改密 / 撤权要等 token 自然过期（管理员 12 小时）才生效，且**没有任何用例会红**。
   * 完整理由见 {@link requireRole} 的 `@param identity`（app/auth.ts）。
   */
  identity: IdentityCheck;
  idGen: IdGen;
}

export function mountAddressRoutes(app: Express, deps: AddressRoutesDeps): void {
  const addresses = createAddressRepo(deps.db);
  const countryProfiles = createCountryProfileRepo(deps.db);

  /**
   * 校验并取出 AddressInput。
   * @why 形状与格式的校验**不在本文件**：它有两个消费方（本文件的地址簿 CRUD、
   *      以及管理端改址 `POST /admin/orders/{id}/address`），两份校验会各自漂移
   *      （@see domain/address-input.ts 文件头 @why）。这里只补它做不了的那一步——
   *      **国家**要查 `country_profiles`，有 I/O，所以留在路由层。
   */
  async function parseAddress(body: unknown): Promise<AddressInput> {
    const input = parseAddressInput(body);
    // 国家：表驱动的"可下单目的国"检查（@why 见文件头）
    const profile = await countryProfiles.get(input.country);
    if (profile === null || !profile.active) {
      throw new AppError(40002, { field: 'country', country: input.country });
    }
    return input;
  }

  app.get(
    '/api/v1/addresses',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          res.json(await addresses.listByUser(sub));
        } catch (e) {
          next(e);
        }
      })();
    },
  );

  app.post(
    '/api/v1/addresses',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const input = await parseAddress(req.body);
          const row = await addresses.create(`addr-${deps.idGen.uuid()}`, sub, input);
          deps.logger.info('address_created', {
            result: 'ok',
            // ⚠️ 必须带 `address_id` 与 `is_default`（AJ-355）：约束七要求关键路径
            //    答得出"谁、做了什么、**对哪个对象**"。只有 `result:'ok'` 时，
            //    用户投诉"我的默认地址怎么变了"只能看到"有过一次新建"，
            //    不知道是哪一条、有没有设成默认——而这两件事正是投诉的内容本身。
            //    `address_id` 是服务端生成的 `addr-<uuid>`，不是 PII（收件人/电话才脱敏）。
            ctx: { address_id: row.id, is_default: row.is_default },
          });
          res.status(201).json(row);
        } catch (e) {
          next(e);
        }
      })();
    },
  );

  app.put(
    '/api/v1/addresses/:id',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const id = paramId(req.params.id);
          const input = await parseAddress(req.body);
          const row = await addresses.update(id, sub, input);
          if (row === null) throw new AppError(40400, { address_id: id });
          // ⚠️ 更新此前**完全不打日志**（AJ-355）：改地址是"谁、做了什么、对哪个对象"
          //    里最容易有争议的一条——用户说"我没改过"，而日志里什么都没有。
          //    带 `is_default`：改的到底是"把这条设成默认"还是"只是改了个门牌号"，
          //    在日志里必须是两件能分开的事。
          deps.logger.info('address_updated', {
            result: 'ok',
            ctx: { address_id: row.id, is_default: row.is_default },
          });
          res.json(row);
        } catch (e) {
          next(e);
        }
      })();
    },
  );

  app.delete(
    '/api/v1/addresses/:id',
    requireRole('user', deps.auth, { identity: deps.identity }),
    (req, res, next) => {
      void (async () => {
        try {
          const sub = req.auth?.sub;
          if (sub === undefined) throw new AppError(40101);
          const id = paramId(req.params.id);
          const ok = await addresses.remove(id, sub);
          if (!ok) throw new AppError(40400, { address_id: id });
          // ⚠️ 同上（AJ-355）：删了哪一条必须可答。"我的默认地址没了"
          //    这类投诉的唯一线索就在这里——没有 id 的话，日志只能说"有人删过一个地址"。
          //    （不为了取 `is_default` 多查一次库：'谁删的'与'删了哪条'已足够定位，
          //     "删之前它是不是默认"可以从这条 id 的创建/更新日志里串出来。）
          deps.logger.info('address_deleted', { result: 'ok', ctx: { address_id: id } });
          res.status(204).end();
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
