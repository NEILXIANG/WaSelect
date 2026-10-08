/**
 * 职责：错误提示下面那一行**求助编号**（报障码，AJ-410 / N5）——全站同一种摆法。
 *
 * @why 原先报障码混在红字句子里（"邮箱、口令或二次验证码不正确（报障码：…）"），新手读到一串乱码会以为是错误本身。
 *      拆成单独一行小灰字，并说清楚"拿它干什么"：出错原因在红字里，编号只在求助时用。
 * @limitation 只负责摆，不负责复制：用 `user-select: all`（一点即全选），不引剪贴板 API（非 HTTPS 下会静默失败）。
 */
export const TRACE_HINT = '如需求助，把这串编号发给技术人员：';

export function TraceLine({ traceId }: { traceId?: string | undefined }): React.JSX.Element | null {
  if (traceId === undefined || traceId === '') return null;
  return (
    <span className="trace-line">
      {TRACE_HINT}
      <span className="selectable">{traceId}</span>
    </span>
  );
}
