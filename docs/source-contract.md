# 合作来源约定

## 资料边界

POST /offers/search 返回 searchId、journeys、offers 和 expiresAt。offer 的 segmentRefs 引用该 searchId 内的航段，travelerRefs 与 fareComponents 保留来源范围。POST /offers/detail 要求 searchId、offerId、detailToken。相同航班号不等于相同 segmentId；/offers/requote 返回 replacesOffer，可改变整组航段，金额使用十进制字符串和 currency，taxIncluded 为三态。

## 本地服务

来源和收件端是两个独立 HTTP 监听器。来源 `/health` 报告运行状态，`/__state` 返回当前情景；仅本地使用的 `POST /__control` 可改变来源情景，不属于收件端的业务 API。具体情景字段在 `provider/scenario.mjs` 的 `initialState` 中定义，切换只影响后续来源响应，不会改写已有收件。探查入口为 `/health`，请求相对链接必须以实际来源地址解释。

## 已有归档约定

人工入口只接收人工确认过的结构化对象，并不验证自动来源完整性。`Archive.accept(source, identity, data, raw)` 把原始字节按摘要保存，并为同一来源与身份保留不同版本。`source` 和 `identity` 的选择必须与业务对象对应，正文摘要只用于原文复用，不代表两份业务记录相同。`src/transport.mjs` 仅提供一次请求，不包含自动分页、协议解释或领域恢复策略。
