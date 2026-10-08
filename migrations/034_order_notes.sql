-- 034：订单内部备注（管理后台对标分析第一批⑤，AJ-396）。
--
-- @why 售后沟通目前全在微信里，换人接手 / 事后追问"当时答应了买家什么"时无处可查；
--      对标文档 §8-3 把"买家售后申请"推迟到第三批，明确写了在此之前用后台内部备注兜。
-- @why 独立一张表，不复用 order_events.note：order_events 是**系统状态机**的时间线（status 列有域约束），
--      往里塞人写的话会让"按状态检索事件"混进非状态行；备注要自己的作者与长度口径。
-- @why append-only（复用 002 的 deny_audit_modification）：备注是"当时谁说了什么"的证据，
--      改得掉就不是证据。写错了的处理方式是**再追加一条更正**，与审计表同口径。
-- @why body 的 CHECK 是**兜底**，主校验在应用层（server/src/domain/order-note.ts）：
--      应用层按 UTF-16 码元 ≤ 1000，库里按 char_length（码位）≤ 1000——应用层更严，库约束永远不会先拒。
--      @measured PostgreSQL 16.15，库 ctype = en_US.UTF-8：`E'\u3000' ~ '^[[:space:]]*$'` → t（全角空格算空白）；
--      `char_length('😀')` → 1；`btrim(E'\u3000') = ''` → f（btrim 默认只去半角空格，所以不用它）。
-- @limitation `[[:space:]]` 是否认全角空格取决于库的 LC_CTYPE：若生产库是 C locale，全角空格只备注
--             会穿过这道兜底（应用层仍会拦住）。生产建库时须确认 ctype（AJ-396 反向风险）。
-- @limitation author 只认 `admin:<id>`：备注只由管理端写；将来若有系统自动备注，需放宽此约束并改契约。
-- @limitation 不级联：order_id 外键无 ON DELETE（与 order_events 同口径），订单本来就不物理删除。
--
-- @see server/src/app/admin-order-note-routes.ts；server/src/adapters/order-notes.ts；
--      packages/shared/src/limits.ts（ORDER_NOTE_MAX_LENGTH）；docs/自主决策记录.md AJ-396

-- Up migration

CREATE TABLE order_notes (
  id         BIGSERIAL PRIMARY KEY,
  order_id   TEXT NOT NULL REFERENCES orders(id),
  author     TEXT NOT NULL CONSTRAINT order_notes_author_check CHECK (author ~ '^admin:[^[:space:]]+$'),
  body       TEXT NOT NULL CONSTRAINT order_notes_body_check
               CHECK (char_length(body) BETWEEN 1 AND 1000 AND body !~ '^[[:space:]]*$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 外键索引（结构不变量：任何外键列都要有索引）兼作详情页"按单取、按时间排"的查询索引
CREATE INDEX idx_order_notes_order_created ON order_notes (order_id, created_at, id);

CREATE TRIGGER trg_order_notes_append_only
  BEFORE UPDATE OR DELETE ON order_notes
  FOR EACH ROW EXECUTE FUNCTION deny_audit_modification();

-- Down migration

DROP TRIGGER IF EXISTS trg_order_notes_append_only ON order_notes;
DROP TABLE IF EXISTS order_notes;
