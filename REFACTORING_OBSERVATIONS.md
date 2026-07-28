# 蜃灵助手保守重构观察项

本文件用于长期记录保守重构各 Phase 审查中确认的非阻塞问题、Compatibility 能力边界、延后治理的技术债，以及需要在特定条件下复查的风险。

## 维护规则

- 观察项使用连续且不复用的编号：`OBS-001`、`OBS-002`……
- 新观察项只追加，不因阶段切换而重排编号。
- 已解决的观察项不得删除；应更新状态，并在“最终关闭记录”中写明关闭 Phase、对应 commit、验证结论和关闭日期。
- 未满足复查条件时，不得把观察项扩大为当前 Phase 的施工范围。
- Compatibility 能力必须按已经验证的范围描述，不得默认与主 Provider 完整等价。

## 状态定义

- `观察中`：当前不阻塞验收，等待复查条件出现。
- `处理中`：已进入明确批准的治理 Phase。
- `已关闭`：已完成修改、验证和审查，并补全最终关闭记录。
- `不再适用`：相关能力已经移除或架构条件已经消失；仍须保留关闭依据。

---

## OBS-001：Chat Compatibility 写入能力范围

- **来源 Phase**：Phase 3B（统一 Chat Provider）
- **当前状态**：观察中
- **现象或能力边界**：`setChatMessagesWithCompatibility` 当前明确覆盖蜃灵现有实际使用的 `message` 与 `is_hidden`。其能力范围比旧 fallback 的通用 `Object.assign` 更窄，不能视为完整等价于 TavernHelper `setChatMessages()`。
- **当前影响**：已核对的实际业务调用仅依赖 `message` 与 `is_hidden`，因此 Phase 3B 不构成行为回归，也不要求返工。
- **为什么本阶段不处理**：扩展未被现有业务使用的字段会扩大 Phase 3B 范围，并可能在缺少真实契约和测试的情况下臆造 Compatibility 语义。
- **触发复查条件**：出现通过 Compatibility 写入 `data`、swipe 或其他聊天消息字段的明确业务需求；或者现有调用方开始向 `setChatMessagesWithCompatibility` 传入上述字段。
- **建议处理阶段**：触发需求所在的 Chat 能力扩展阶段，或后续明确批准的 Chat Compatibility 治理阶段。
- **最终关闭记录**：

## OBS-002：Chat Compatibility 刷新路径

- **来源 Phase**：Phase 3B（统一 Chat Provider）
- **当前状态**：观察中
- **现象或能力边界**：Compatibility 写入后的刷新按能力组合选择：`refreshOneMessage` 存在时复用 `refreshOneMessage`；该能力不存在时使用 `reloadCurrentChat`。这是能力缺失时的 capability fallback，不是 Provider 执行失败后通过 catch 自动切换实现。
- **当前影响**：该路径符合“能力不存在时允许选择 Compatibility；Provider 已存在但执行失败时必须暴露错误”的原则。不同能力组合下，刷新粒度可能分别为单楼刷新或整聊重载。
- **为什么本阶段不处理**：Phase 3B 已验证该选择只发生在能力缺失时，当前不存在错误被备用路径掩盖的问题；进一步统一刷新生命周期属于后续治理范围。
- **触发复查条件**：Chat 生命周期或刷新事件治理启动；`refreshOneMessage` / `reloadCurrentChat` 契约变化；发现重复 rendered/CHAT_CHANGED 事件、Swipe 状态异常或刷新后 UI 不一致。
- **建议处理阶段**：后续 Chat 生命周期治理阶段，或相关刷新回归首次出现并获准处理的 Phase。
- **最终关闭记录**：

## OBS-003：Worldbook 绑定失败后的孤儿世界书风险

- **来源 Phase**：Phase 0（全仓审计）确认，Phase 3C（统一 Worldbook Provider）复核
- **当前状态**：观察中
- **现象或能力边界**：创建回忆录专属世界书成功后，如果 `rebindChatWorldbook` 失败，现有流程只会在 `deleteWorldbook` 能力存在时尝试清理；清理自身的异常目前不会替代原始绑定错误。因此，清理能力缺失或清理失败时可能留下未绑定的孤儿世界书。
- **当前影响**：自动创建并绑定失败时，世界书列表中可能残留本次创建但未绑定的世界书；正常创建、绑定和写入路径不受影响。
- **为什么本阶段不处理**：Phase 3C 只提升并统一平台接口边界，重新设计创建、绑定、回滚和错误聚合属于世界书生命周期或事务语义治理，且 Provider 迁移本身不要求改变现有控制流。
- **触发复查条件**：真实环境复现孤儿世界书；获得清理失败证据；启动世界书生命周期/事务治理；或 TavernHelper 创建、绑定、删除接口契约发生变化。
- **建议处理阶段**：后续明确批准的 Worldbook 生命周期或事务治理阶段。
- **最终关闭记录**：

## OBS-004：Schedule 生成超时可能偏短

- 来源 Phase：Phase 4A 后续用户反馈
- 当前状态：已关闭

### 现象

Schedule / 日程表曾使用：

`180000 ms`

即：

`180 秒 / 3 分钟`

已有用户反馈：

> 日程表有时还没有生成完成，就会因为超时而失败。

### 处理结果（Phase 4E-2C / 4E-2D）

1. Phase 4E-2C：副 API timeout 覆盖 `fetch` + `response.text()`，并通过 AbortController 真实取消；主 API 保持 wait-only。
2. Phase 4E-2D：Schedule timeout 调整为 `300000` ms（300 秒）；主 API timeout 文案诚实表达“已停止等待 / 可能仍在后台继续”；副 API timeout 文案表达“请求已取消，可稍后重试”。
3. 迟到结果隔离测试确认主 API timeout 后迟到成功/失败不会二次 settle、不写 Schedule 成功状态。
4. 其他 Feature timeout 未因本观察项被统一改写；Diary / Summary 仍无主动 timeout。

### 最终关闭记录

- 关闭阶段：Phase 4E-2D / Phase 4E-2E Final Audit
- Schedule timeout 调整提交：`e0376fdb3f49ec75d7edfa3f0d5d5d67cca7e71e`（`Phase 4E-2D`）
- 副 API 完整 timeout/cancellation 实现提交：`4ebb3e706e5e921ae4eabfa18cac5ae96ce7846e`（`Phase 4E-2C: complete secondary API timeout coverage`）
- 2C 相关后续提交 / 验收基线 HEAD：`f52c3163e111a9f27a91ffaf57f02c8e5a6a4a82`（`4E-2C`）
- 测试结论：`tests/schedule-generation-timeout.test.mjs` 与 `tests/generation-core.test.mjs` 覆盖 300 秒传参、主副文案语义、迟到 Promise、body 阶段 timeout；全仓相关测试全绿
- 关闭日期：2026-07-28

---

## OBS-005：Summary total-grand memory 现有回归测试失败

- **来源 Phase**：Phase 4C-1 联合回归
- **当前状态**：已关闭
- **发现位置**：`tests/summary-total-grand-memory.test.mjs` 第 3 项“automatic trigger uses freshCount instead of total merge material count”。
- **最终根因**：测试夹具将 `message_id` 为 `100`、`110`、`120`、`130` 的消息放入长度为 4 的 `context.chat`。Compatibility Provider 以 `context.chat.length - 1` 作为最后楼层号，并按该范围读取消息；因此请求高 message ID 时范围被截断，找不到对应聊天消息，`freshCount` 错误地成为 `0`。
- **为什么属于测试夹具问题**：真实 SillyTavern 聊天数组以数组索引表示楼层号。生产代码的 Compatibility 路径正是按该语义读取；原夹具的高 message ID 与短数组索引不一致，不能模拟真实聊天数据。
- **生产代码影响**：无。已确认 `src/features/summary/workflow.js` 与 `src/core/chat.js` 无需修改，永劫合并阈值、`compressedBy` 和 `compressedRecordIds` 生产逻辑保持不变。
- **修复方式**：将该测试的 baseline 与后续普通大总结记录改为连续的 `0`、`1`、`2`、`3`，使 `message_id` 与 `context.chat` 数组索引一致；断言、阈值与业务覆盖保持不变。
- **验证结果**：`node tests/summary-total-grand-memory.test.mjs` 通过 5/5；第 3 项恢复验证 `freshCount` 而非总合并材料数触发自动合并。
- **建议处理阶段**：已于 Phase 4C-1 Audit Fix 处理。
- **最终关闭记录**：关闭阶段：Phase 4C-1 Audit Fix；关闭提交：`6239ade298aca24995e1c4e32574fd566261e5f3`；提交标题：`Phase 4C-1 Audit Fix`；验证结论：Summary total-grand memory 回归测试通过，生产代码无须修改；关闭日期：2026-07-26。

---

## OBS-006：Generation Core 抛错路径缺少结构化请求诊断信息

- **来源 Phase**：Phase 4C-1 审查后复核。
- **当前状态**：已关闭。
- **现象或能力边界**：Generation Core 曾只有成功返回值携带 URL、请求体、HTTP 状态和模型响应。若主/副 API Core 在返回结果前抛错，Feature 无法取得 `apiResult`，失败通信日志只能使用各自的局部兜底字段；Error 也没有稳定的 `code`、`stage`、`diagnostics` 或 `cause`。
- **处理结果**：

  1. Phase 4E-2A：建立 `GenerationTransportError` 与 `getGenerationErrorContext()`，提供白名单 `code / stage / diagnostics` 与 `cause`；敏感 URL / responseText 脱敏截断。
  2. Phase 4E-2B：七个直接 Core 调用方全部接入失败日志；Affection Core 返回前失败时 messages 不再丢失；普通 Feature Error 不伪装 Transport code。
  3. Phase 4E-2C：副 API 完整 timeout/cancellation；浏览器实机错误注入确认结构化 Error 与 stage 语义。
  4. Phase 4E-2E Final Audit：全仓复核七 Feature 接入、测试与安全边界。
- **最终关闭记录**：

  - 关闭阶段：Phase 4E-2A 至 2E Final Audit
  - 2A 提交：`bfbddb74da893622ea48987736d597e528116ade`（`Phase 4E-2A`）
  - 2B 提交：`89601ea8394e8953d6f8d61173eab22e78cf655e`（`Phase 4E-2B`）
  - 2C 提交：`4ebb3e706e5e921ae4eabfa18cac5ae96ce7846e`（`Phase 4E-2C: complete secondary API timeout coverage`）
  - 浏览器实机验收相关 HEAD：`f52c3163e111a9f27a91ffaf57f02c8e5a6a4a82`（`4E-2C`）
  - 七 Feature 测试：`tests/generation-feature-failure-logs.test.mjs` 全绿；Core 契约 `tests/generation-core.test.mjs` 全绿
  - 敏感信息结论：失败 diagnostics / 通信日志不记录 API Key、Authorization、headers、完整 profile 或 cause
  - 关闭日期：2026-07-28

## OBS-007：主 API Provider 解析异常尚未纳入统一 Generation 错误契约

- **来源 Phase**：Phase 4E-2A GitHub 实际提交审查。
- **当前状态**：处理中。
- **现象或能力边界**：`generateWithMainApi()` 优先使用 `globalThis.generateRaw`。当该入口不存在时，Core 会继续调用 `globalThis.SillyTavern?.getContext?.()` 获取备用的原生 `generateRaw`。如果 `getContext()` 函数存在但自身执行抛错，该异常发生在主 API Provider 解析过程中；Phase 4E-2E 施工前会以普通 `Error` 直接向上抛出，`getGenerationErrorContext(error)` 返回 `null`。
- **当前影响**：

  - 当前 SillyTavern 1.18.0 实际环境优先命中 `globalThis.generateRaw`，该异常分支触发概率较低。
  - 不影响主 API 正常成功路径。
  - 不会吞掉原始错误，也不会自动切换到副 API。
- **Phase 4E-2E 处理**：

  1. 隔离测试复现旧行为：全局 `generateRaw` 缺失且 `getContext()` 抛错 → 普通 Error 逸出。
  2. Core 将 Provider 解析异常包装为 `GenerationTransportError`：
     - code：`MAIN_PROVIDER_RESOLUTION_FAILED`
     - stage：`resolve_provider`
     - diagnostics：`provider / messageCount / durationMs`
     - `cause` 保留原始错误身份
  3. Provider 优先级不变：全局 `generateRaw` 优先；存在时不调用 `getContext()`。
  4. `getContext()` 正常但无 `generateRaw` 仍为 `MAIN_PROVIDER_MISSING`。
  5. 无主副 API fallback。
- **当前处理状态说明**：代码与隔离测试已完成，等待用户提交后 GitHub 审查及最终 SHA 补录；不得伪造实现提交 SHA。
- **关闭条件**：GitHub 审查通过后，以纯文档提交将状态改为“已关闭”，并补录真实实现 SHA 与审查结论。
- **最终关闭记录**：
