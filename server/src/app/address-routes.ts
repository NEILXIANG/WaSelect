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
 * @limitation 一：PUT 是全量替换语义（契约 AddressInput 全字段），不做 PATCH。
 * @limitation 二：地址 CRUD 暂不挂限流——它是低频本人写路径（攻击面在登录/报价/短链）；
 *              真出现脚本刷地址时再按 rateLimitRules 表加规则（规则表是唯一出处）。
 *
 * @see contracts/api-contract.yaml（AddressInput/Address）；adapters/addresses.ts；
 *      migrations/001_init.sql（CHECK 同源）+ 011（默认唯一索引）
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

/** 列宽（与 001 的 VARCHAR 一致）：超长属"形状错"（40001），DB 兜底是最后一道。 */
const LEN = {
  recipient: 100,
  phone: 20,
  line1: 200,
  line2: 200,
  city: 100,
  postal_code: 10,
} as const;
const ASCII_RE = /^[ -~]+$/;
const ASCII_OR_EMPTY_RE = /^[ -~]*$/;
const PHONE_RE = /^\+1[0-9]{10}$/;
const POSTAL_RE = /^[0-9]{5}(-[0-9]{4})?$/;

export interface AddressRoutesDeps {
  db: Db;
  logger: Logger;
  auth: AuthConfig;
  identity?: IdentityCheck | undefined;
  idGen: IdGen;
}

export function mountAddressRoutes(app: Express, deps: AddressRoutesDeps): void {
  const addresses = createAddressRepo(deps.db);
  const countryProfiles = createCountryProfileRepo(deps.db);

  /** 校验并取出 AddressInput；国家做表驱动的可下单检查（异步）。 */
  async function parseAddress(body: unknown): Promise<AddressInput> {
    const b = body as Record<string, unknown> | null;
    if (b === null || typeof b !== 'object') throw new AppError(40001, { reason: 'body_shape' });

    const requiredStrings = [
      'recipient',
      'phone',
      'line1',
      'city',
      'state',
      'postal_code',
    ] as const;
    for (const k of requiredStrings) {
      if (typeof b[k] !== 'string' || (b[k] as string).length === 0) {
        throw new AppError(40001, { reason: `${k}_required` });
      }
    }
    const input: AddressInput = {
      recipient: b['recipient'] as string,
      phone: b['phone'] as string,
      line1: b['line1'] as string,
      line2: b['line2'] === undefined || b['line2'] === null ? null : String(b['line2']),
      city: b['city'] as string,
      state: b['state'] as string,
      postal_code: b['postal_code'] as string,
      country: b['country'] === undefined ? 'US' : String(b['country']),
      is_default: b['is_default'] === true,
    };
    // 形状：列宽（40001）
    if (input.recipient.length > LEN.recipient)
      throw new AppError(40001, { reason: 'recipient_too_long' });
    if (input.phone.length > LEN.phone) throw new AppError(40001, { reason: 'phone_too_long' });
    if (input.line1.length > LEN.line1) throw new AppError(40001, { reason: 'line1_too_long' });
    if (input.line2 !== null && input.line2.length > LEN.line2) {
      throw new AppError(40001, { reason: 'line2_too_long' });
    }
    if (input.city.length > LEN.city) throw new AppError(40001, { reason: 'city_too_long' });
    if (input.postal_code.length > LEN.postal_code) {
      throw new AppError(40001, { reason: 'postal_code_too_long' });
    }
    // 格式（40002，表单可修正）
    if (!ASCII_RE.test(input.recipient)) throw new AppError(40002, { field: 'recipient' });
    if (!ASCII_RE.test(input.line1)) throw new AppError(40002, { field: 'line1' });
    if (input.line2 !== null && !ASCII_OR_EMPTY_RE.test(input.line2)) {
      throw new AppError(40002, { field: 'line2' });
    }
    if (!ASCII_RE.test(input.city)) throw new AppError(40002, { field: 'city' });
    if (!PHONE_RE.test(input.phone)) throw new AppError(40002, { field: 'phone' });
    if (!/^[A-Z]{2}$/.test(input.state)) throw new AppError(40002, { field: 'state' });
    if (!POSTAL_RE.test(input.postal_code)) throw new AppError(40002, { field: 'postal_code' });
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
          deps.logger.info('address_created', { result: 'ok' });
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
          deps.logger.info('address_deleted', { result: 'ok' });
          res.status(204).end();
        } catch (e) {
          next(e);
        }
      })();
    },
  );
}
