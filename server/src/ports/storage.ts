/**
 * 职责：**对象存储端口**（I2 U-I3）——把"图片字节放哪"从业务代码变成可替换的驱动。
 *
 * @why 上传管线在测试里不能碰真 R2/S3（外网闸门 AJ-56：未放行出站直接抛错），
 *      在开发期没有 R2 凭据（公司登记链还卡着）——三种环境三种驱动，
 *      端口就是换驱动不换业务的那条缝（ADR-28 的可换零件）。
 *
 * @why 接口只有 `put`，没有 get/delete/list：
 *      读由 HTTP/CDN 承担（`IMG_BASE_URL` + key，见 admin-banner-routes），
 *      不经过服务端进程——服务端不需要"读回自己写的字节"这条路径；
 *      删除没有 MVP 消费方（孤儿图清理属运营阶段）。**无消费方的方法不进端口**
 *      （ADR-28：无消费方的字段是死数据，方法同理）。
 *
 * @limitation 一：`put` 语义是**覆写**（同 key 后写覆盖先写），实现方不得追加或报错——
 *              重复上传同一 id 的三档是合法操作（重传）。
 * @limitation 二：`contentType` 的实现保真度**按驱动分档**：S3/R2 会存成对象元数据
 *              （决定响应头）；fs 驱动**丢弃**它（开发期静态服务按扩展名猜）——
 *              调用方不得依赖"读回的 Content-Type 一定等于写入值"。
 *
 * @see adapters/storage-memory.ts（测试/e2e）；adapters/storage-fs.ts（开发期）；
 *      R2/S3 适配器待凭据落地另立单元
 */
export interface ObjectStorage {
  put(key: string, bytes: Buffer, contentType: string): Promise<void>;
}
