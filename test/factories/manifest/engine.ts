/**
 * 职责：**任意 fixture 域**的形态清单核对引擎（把 CLAUDE.md 的 H2 人工项机器化一半）。
 *
 * @why H2「fixture 的边界维度够不够」此前完全靠人：谁能想到"美国收件地址还有军邮"，
 *      才有机会去补军邮样本。想不到的维度，数据里就一定没有，
 *      而**没有的那种数据，永远不会让任何一条断言变红**——于是代码看起来全对。
 *
 *      所以把"想到什么维度"这件事**外化成一份清单**，再让机器去核双向一致：
 *        · 正向：清单里标"必须有"的形态，数据里**必须**至少有一条命中 → 防漏维度；
 *        · 反向：数据里每一条**必须**命中清单里的某个形态 → 防"清单没登记这条数据"，
 *          也顺带防住假数据本身不真实（不真实的形状登记不进去）；
 *        · 自洽：标了"本项目不适用（n/a）"却没写原因 → 违规；
 *          标了 n/a 却**真的**有样本命中 → 违规（清单与实际互相矛盾）。
 *
 *      正反向都查是关键：只查正向的话，清单里写个不存在的形态 id 永远绿——
 *      这正是本仓库反复踩到的假绿灯形态（"看起来跟真绿灯一模一样"）。
 *
 * @limitation 一：**引擎管不了"清单本身有没有漏维度"**。它只能保证"清单写了的，数据就得有"。
 *              "美国地址还有没有别的真实形态"（乡村路线 RR、酒店代收、大学宿舍……）
 *              仍然只能靠人先写进清单——这一步就是 CLAUDE.md 的 H2，机器替代不了。
 * @limitation 二：`matches` 是个谓词，引擎判断不了它写得对不对。
 *              一个永远返回 true 的谓词会让所有形态"都被覆盖"。
 *              靠 review + 反向检查（样本必须落在某个形态上）部分对冲，但不彻底。
 * @limitation 三：新增 fixture 域**不会自动进入检查**——必须有人写 manifest 文件
 *              并在对应的测试里调用 `audit()`。这是显式的注册成本，宁可这样，
 *              也不要用"猜哪些文件是 fixture"的魔法规则（猜错就静默失效）。
 *
 * @see CLAUDE.md 约束三（假数据要像真的）与 H2；./us-address.ts（首个接入域）
 */

/** 一条真实形态（正例）或一类脏输入（反例）。 */
export interface ShapeDef<T> {
  /** 形态代号，域内唯一；会出现在红灯信息里 */
  id: string;
  /** 这句话要说明"为什么真实世界存在这种形态"——红灯时会打出来，写得含糊等于白写 */
  why: string;
  /**
   * `true` = 数据里必须有样本；
   * `string` = 本项目明确不适用，**字符串就是原因**。
   * @why n/a 必须带原因：不带原因的豁免会让整份清单失效——
   *      事后没人能区分"想明白了故意不做"和"压根没想到"。
   */
  coverage: true | string;
  matches: (sample: T) => boolean;
}

export interface Violation {
  /** 出问题的形态代号（样本级问题时为空） */
  shapeId?: string;
  /** 出问题的那条数据的可读标识 */
  sample?: string;
  reason: string;
}

export interface AuditInput<T> {
  shapes: readonly ShapeDef<T>[];
  pool: readonly T[];
  /** 用于在红灯信息里定位是哪一条数据 */
  label: (sample: T) => string;
}

/**
 * 核对清单与数据的双向一致。
 * @returns 违规列表；空数组 = 一致。**调用方要把内容打出来**，不要只断言数量——
 *          只断言数量的红灯是一个看不出原因的数字，等于没报。
 */
export function audit<T>(input: AuditInput<T>): Violation[] {
  const { shapes, pool, label } = input;
  const out: Violation[] = [];

  // ── 第 0 层：清单自身的形状就不合法 ────────────────────────────────
  const seen = new Set<string>();
  for (const s of shapes) {
    if (seen.has(s.id)) out.push({ shapeId: s.id, reason: '形态代号重复' });
    seen.add(s.id);
    if (typeof s.coverage === 'string' && s.coverage.trim().length === 0) {
      out.push({ shapeId: s.id, reason: '声明了 n/a 却没写原因（不许有无原因的豁免）' });
    }
  }

  // ── 第 1 层（正向）：必须有的形态，数据里有没有 ──────────────────────
  for (const s of shapes) {
    if (s.coverage !== true) continue;
    if (!pool.some((sample) => s.matches(sample))) {
      out.push({ shapeId: s.id, reason: `清单要求必须有样本，但一条都没有：${s.why}` });
    }
  }

  // ── 第 2 层（反向）：数据里的每一条，清单有没有登记 ────────────────────
  for (const sample of pool) {
    if (!shapes.some((s) => s.matches(sample))) {
      out.push({
        sample: label(sample),
        reason: '这条数据不属于清单里任何一个形态（清单漏了维度，或这条数据本身不真实）',
      });
    }
  }

  // ── 第 3 层（自洽）：声明不适用的形态，却真的命中了样本 ──────────────────
  for (const s of shapes) {
    if (s.coverage === true) continue;
    const hit = pool.find((sample) => s.matches(sample));
    if (hit !== undefined) {
      out.push({
        shapeId: s.id,
        sample: label(hit),
        reason: `标了「不适用：${s.coverage}」，但数据里其实有样本命中——清单与实际矛盾`,
      });
    }
  }

  return out;
}

/** 把违规列表渲染成能直接读的红灯文本。 */
export function formatViolations(vs: readonly Violation[]): string {
  return vs
    .map((v) => `  · [${v.shapeId ?? '样本'}] ${v.sample ?? ''} ${v.reason}`.trimEnd())
    .join('\n');
}
