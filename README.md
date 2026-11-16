# 联程出行资料的航段组合与报价表示采集

这是面向资料接收人员的 Node.js 服务。当前同时提供人工收件与自动来源查询领取，两者写入同一归档但来源标识互不混淆。自动接入只做查询、凭据领取与留档，不调用任何预订或购买接口。

## 环境

支持 Node.js 22.22.1 及以上的 22.x 补丁版本；项目 Dockerfile 仍固定原有镜像摘要以保证可复现，正式 Linux 基线另外在 Node.js 22.23.4 验证。运行期没有第三方包及公网数据依赖。`npm ci --ignore-scripts --no-audit --no-fund` 安装锁定环境，`npm run build` 检查所有模块语法，`npm test` 验证归档、HTTP 入口及来源行为。来源材料均为本地合成的业务样本，没有真实账号、个人材料或访问外部站点的要求。

`npm start` 同时启动收件服务 3200 和来源 4200；可分别通过 `PORT`、`SOURCE_PORT` 修改端口。收件端默认按 `SOURCE_PORT` 推导来源地址，也可用 `SOURCE_BASE` 显式指定。`ARCHIVE_DIR` 指定收件目录，默认 `.local/archive`。`npm run demo` 使用临时目录和系统分配端口演示自动采集、审批视图、过期重查与人工收件，结束即清理，通常只需数秒。

## 容器

`docker build -t itinerary-offers:local .` 构建环境，`docker run --rm -p 3200:3200 -p 4200:4200 itinerary-offers:local` 启动。环境准备后，`docker run --rm --network none itinerary-offers:local sh -c 'npm run build && npm test && npm run demo'` 可离线检查全部功能。正式展示应从干净归档启动真实新增功能并展示当前输出，完整操作限时 90 秒；准备镜像不计入运行时间。

## 接口与目录

### 人工收件（既有）

`POST /api/manual` 接收 `fixtures/manual.json` 同形的业务对象，`GET /api/records` 查询全部收件版本（含人工与自动），`GET /health` 检查进程并报告当前采集能力。人工记录身份字段为 search, offer。

### 自动查询领取（新增）

`POST /api/collect` 以 `{ "from": "HAK", "to": "SHA" }` 向来源发起一次 `/offers/search`，对返回的每个报价用其短效 `detailToken` 领取 `/offers/detail`，然后把**该报价作为整体**留档：同一 search 的整组 `journeys`、报价的 `segmentRefs`/`travelerRefs` 作用域、计价组件与条件、以及 search/detail 两份原始响应字节的摘要。系统不提供任何跨报价重组代码路径：校验器拒绝引用本次查询之外航段或乘客作用域的报价，金额使用来源给出的十进制字符串与币种，`taxIncluded` 保留 `true`/`false`/`null` 三态。

`POST /api/requote` 以 `{ "offerId": "..." }` 处理短效凭据过期后的重查。它先调用来源 `/offers/requote` 取得替代报价，再重新整组查询航段并领取替代报价详情；**原观察保持不动**，新观察通过 `lineage`（`relation: "replacement"`、`replacedOfferId`、含 requote 原始字节摘要的 predecessor）与原报价建立关系。重查任一步失败都不会写入半条记录。

`GET /api/review` 面向审批人汇总自动观察：
- 每条观察标明价格是否已领取（`pricing.status` 为 `priced`/`expired`/`invalid-credential`）；
- `disclosure` 区分已披露的计价条件、含税口径、币种与仍待补取项，过期观察不编造价格，只保留过期响应原文与待补取说明；
- 替代观察的 `changesFromPredecessor` 只在 lineage 指认的相邻观察之间对照币种、含税口径、总价与航段路由是否改变；
- `superseded` 标出已被替代的旧观察，`evidence` 给出可回查的原始字节摘要。

### 归档结构

归档目录有按摘要保存的 blobs（人工原文、自动 search/detail/requote 原始字节）和按业务身份保存的 receipts。自动记录的来源标识为 `source`，身份为 `{ search: searchId, offer: offerId }`；同一身份与相同内容重复领取复用版本，内容变化保留旧版本。`src/` 为收件、自动领取（`source.mjs`）与审批视图（`review.mjs`），`provider/` 为独立来源服务，`fixtures/` 保留来源字节与人工记录，`test/` 验证现有行为。协议范围与局部身份约定见 `docs/source-contract.md`，该文档不规定新增接入的架构；自动接入自身的留档约定见 `docs/auto-collection.md`。
