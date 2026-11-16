# 自动查询领取留档约定

本文档描述收件端自动来源接入（`src/source.mjs`、`src/review.mjs`）自身的留档语义。合作来源的协议边界仍以 `source-contract.md` 为准。

## 不重组、不预订

- 接入只调用来源的查询类接口：`/offers/search`、`/offers/detail`、`/offers/requote`，没有任何预订、出票或购买调用。
- 一次报价的多个航段、乘客适用范围和计价条件按来源实际给出的整体保存。`validateSearch` 要求每个 offer 的 `segmentRefs` 全部落在本次 search 返回的 `journeys` 标识集合内；`validateDetail` 要求 `fareComponents` 的 `travelerRef` 与 `segments` 全部落在该 offer 自己的 `travelerRefs`/`segmentRefs` 作用域内，且每个适用乘客恰好有一条计价组件。校验函数只接收单次响应与对应 offer，不接收其他报价，因此代码结构上不存在把不同报价的便宜航段拼成新组合的路径。
- 相同航班号不代表相同 `segmentId`，航段一律以标识引用，不以航班号归并。

## 短效凭据与观察版本

- 详细价格只用该报价自己的 `detailToken` 领取；凭据返回 410 时观察标记为 `expired`，返回 409 时标记为 `invalid-credential`。两种情况下都不构造价格、币种或条件，只保存错误响应原始字节与待补取说明。
- 留档数据（`source-offer-observation`）不含本机时钟字段，领取时间由归档版本的 `receivedAt` 统一记录，因此对相同来源结果的重复领取能稳定复用版本，不会凭空制造“新观察”。
- 过期重查（`/api/requote`）不覆盖原观察：替代方案以新业务身份独立留档，`lineage.relation = "replacement"`、`lineage.replacedOfferId` 指回原报价，predecessor 中保存 requote 原始字节摘要。替代报价的航段组必须重新整组查询，不允许沿用原观察里的航段；requote 指定的报价若不在重查结果中则整笔拒绝。任一步失败都在写入前抛出，归档中不留半成品。

## 审批视图（GET /api/review）

- 价格状态三分类：`priced`（已领取）、`expired`（凭据过期待重查）、`invalid-credential`（凭据不被接受待重查）。
- `disclosure` 区分已披露与待补取：计价条件（`conditions` 为 `null` 即未披露）、含税口径（任一组件 `taxIncluded` 为 `null` 即未确定）、币种（多币种并存时不擅自归并）。
- 变化对照只在 lineage 相邻的两次观察之间进行，字段包括币种、含税口径、总价与航段路由（segmentId + 航班号 + 起降城市）；没有 lineage 关系的报价互不比较。
- 每条观察附 `evidence.searchRawSha256` 与 `evidence.pricingRawSha256`，原始字节可经 `Archive.bytes` 或 blobs 目录回查核对。

## 归档身份

- 自动记录 `source = "source"`，身份键为 `{ search: searchId, offer: offerId }`，与人工入口的 `source = "manual"` 隔离，`GET /api/records` 同时可见但来源不混淆。
- search、detail、requote 的原始 HTTP 响应字节分别以内容摘要存入 blobs；receipt 中保存结构化观察与摘要引用，正文摘要只用于原文复用，不代表业务记录相同。
