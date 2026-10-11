/**
 * 职责：错误提示下面那一行**求助编号**（报障码，AJ-410 / N5）——全站同一种摆法。
 *
 * @why 原先报障码混在红字句子里（"邮箱、口令或二次验证码不正确（报障码：…）"），新手读到一串乱码会以为是错误本身。
 *      拆成单独一行小灰字，并说清楚"拿它干什么"：出错原因在红字里，编号只在求助时用。
 * @why 三端模拟测试 2026-10-11（用户截图指出）：36 位 uuid 一长串念不出、抄易错。正文只显示前 8 位
 *      （服务端日志按 trace_id 前缀能查到，与小程序报障小字同口径），悬停看全文，「复制」复制完整编号。
 * @limitation 复制用剪贴板 API：非 HTTPS / 没给权限时会失败——失败就改为显示完整编号，提示手动选中（不静默）。
 *             12 位以内的编号原样显示、不给复制按钮（本来就念得出）。
 */
import { useState } from 'react';

export const TRACE_HINT = '如需求助，把这串编号发给技术人员：';

const SHORT_MAX = 12;

export function TraceLine({ traceId }: { traceId?: string | undefined }): React.JSX.Element | null {
  const [copy, setCopy] = useState<'idle' | 'ok' | 'failed'>('idle');
  if (traceId === undefined || traceId === '') return null;
  const long = traceId.length > SHORT_MAX;
  const shown = long && copy !== 'failed' ? traceId.slice(0, 8) : traceId;
  const onCopy = (): void => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(traceId);
        setCopy('ok');
      } catch {
        setCopy('failed');
      }
    })();
  };
  return (
    <span className="trace-line">
      {TRACE_HINT}
      <span className="selectable" title={traceId}>
        {shown}
      </span>
      {long && (
        <>
          {' '}
          <button type="button" className="link" onClick={onCopy}>
            复制
          </button>
          {copy === 'ok' && ' 已复制'}
          {copy === 'failed' && ' 复制没成功，请手动选中上面的编号'}
        </>
      )}
    </span>
  );
}
