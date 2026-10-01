/**
 * 职责：对象键的**安全校验**（唯一实现）。
 *
 * @why 之前这段正则只活在 `storage-fs.ts` 里。R2 适配器是第二个驱动，
 *      复制一份就是 ADR-29 说的"同一判断的两份实现必然漂移"——
 *      而它漂移的方向是最坏的那一侧：fs 收紧了、S3 没收紧，于是某个 key
 *      **只在生产驱动上**能写穿（开发期测不出来，上线后才发现）。
 *      所以抽出来共用，两个驱动各调同一个函数。
 *
 * @why 用**白名单字符 + 显式拒 `..`** 两段判断，而不是"过滤掉危险字符"：
 *      黑名单永远是漏的（这次想到 `..`，下次是 URL 编码的 `%2e%2e` 或反斜杠）；
 *      白名单的失效方向是"合法的 key 被拒"（响亮、立刻可见），
 *      黑名单的失效方向是"危险的 key 被放行"（静默、可能永久）。
 *
 * @limitation 白名单只允许**小写**字母数字与 `-_.` / `/`，且必须以小写字母数字开头、
 *      以扩展名结尾。它匹配的是本项目实际产生的键形（`img/{id}/{tier}.webp`）；
 *      将来要支持大写或更长的前缀，改的是这一处，不是两个驱动。
 *
 * @see ports/storage.ts（端口语义）；adapters/storage-fs.ts；adapters/storage-r2.ts
 */

/** 白名单：小写字母数字 / `-_.` / `/`，首字符须字母数字，必须有扩展名。 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9\-_./]*\.[a-z0-9]+$/;

/**
 * 校验 key；不合法 → 抛 `Error('object_key_unsafe')`（编程错误，折叠成 50000 是正确表现）。
 *
 * @why 先整体匹配再显式拒 `..` / `//` / `\`：单靠正则排除 `..` 会漏掉
 *      `a/./b` 这类"正则看着合法、路径语义上仍是穿越"的边角。
 */
export function assertSafeObjectKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('//') || key.includes('\\')) {
    throw new Error('object_key_unsafe');
  }
}
