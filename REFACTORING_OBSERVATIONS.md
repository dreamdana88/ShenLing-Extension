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
- 当前状态：观察中

### 现象

Schedule / 日程表当前生成超时为：

`180000 ms`

即：

`180 秒 / 3 分钟`

已有用户反馈：

> 日程表有时还没有生成完成，就会因为超时而失败。

日程表通常需要一次生成完整 7 天的结构化内容，输出量较大。对于：

- 响应较慢的模型；
- 推理模型；
- API 高峰期；
- 网络较慢的副 API；

180 秒可能不足。

### 当前影响

可能出现：

1. 模型仍在正常生成；
2. 插件已经先判定超时；
3. 用户看到生成失败；
4. 底层请求实际上可能仍继续执行。

当前 Generation Core 的 timeout 使用 `Promise.race()`。

该机制只负责停止上层等待，不代表底层请求已真正取消。

对于副 API，当前 timeout 主要覆盖等待 `fetch()` 返回响应的阶段，后续 `response.text()` 与解析不完全处于同一超时控制范围内。

### 为什么当前阶段不处理

Phase 4A 与 Phase 4B 的目标是统一 Generation Transport，并保持原有业务行为。

当前不应在迁移过程中同时修改 Schedule 的产品级超时策略，以免把“架构迁移”和“行为调整”混在同一个 Phase。

### 触发复查条件

在以下阶段必须重新评估：

- Phase 4E Generation 收尾；
- Generation timeout / cancellation 统一治理；
- 后续收到更多 Schedule 超时用户反馈时。

### 建议处理方向

Phase 4E 重新评估：

- Schedule 默认超时是否从 180 秒提高至 300 秒或更高；
- 是否允许不同 Feature 保留不同默认超时；
- 是否需要提供用户可配置超时；
- 副 API timeout 是否应覆盖完整的请求、正文读取与处理流程；
- 能安全取消的请求是否使用真正的 cancellation；
- 主 API 与副 API 是否能够采用一致且真实的超时语义。

不得为了接口形式统一，强制所有 Feature 使用同一个超时时间。

### 建议处理阶段

Phase 4E：Generation 收尾与 timeout 策略复查。

### 最终关闭记录

暂未关闭。

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
- **当前状态**：观察中。
- **现象或能力边界**：Generation Core 只有成功返回值携带 URL、请求体、HTTP 状态和模型响应。若主/副 API Core 在返回结果前抛错，Feature 无法取得 `apiResult`，失败通信日志只能使用各自的局部兜底字段。当前 Error 没有稳定的 `code`、`stage`、`diagnostics` 或 `cause`。
- **可能涉及的错误**：主 API Provider 缺失或执行失败；副 API Profile/model/URL 构建失败、fetch 网络错误、timeout、`response.text()` 失败、HTTP 非成功状态（包括 HTTP 429）以及成功响应缺少模型正文。当前 Core 会捕获 `JSON.parse(responseText)` 失败并将 `responseJson` 置空，非空纯文本仍作为正文返回；因此“非 JSON”本身不是 Core 返回前错误，Summary 对 HTTP 200 非 JSON 的拒绝发生在 Core 成功返回后的 Feature 契约层。
- **当前影响**：不影响成功生成；不吞掉原始错误；不触发 Provider fallback；不改变用户 API 配置。但会降低全部七个 Core 调用方在主/副 API 故障时的通信日志完整度。
- **已确认影响范围**：Phase 4E-1 全仓审计确认七个直接调用方均受影响：Schedule、Mini Theater、Plot Outline、Diary、Affection 专属阶段表、Memoir 设定采集、Summary。Core 返回前失败时，七者都无法取得副 API URL、HTTP 状态或响应正文；Schedule、Mini Theater、Plot Outline 仅保留上下文类请求兜底，Diary 与 Summary 的副 API 请求体为 `null`，Memoir Capture 为 `{}`，Affection 仅保留任务元数据且当前外层 catch 还会丢失已经构造的 messages。各调用方仍保留原始错误且不触发 Provider fallback。
- **为什么本阶段不处理**：Phase 4E-1 只允许全仓审计与治理设计，禁止直接新增 Generation Error、diagnostics 或批量修改 Feature failure catch。
- **触发复查条件**：Phase 4E-2A 建立 Core 错误诊断契约，并由 Phase 4E-2B 完成七个 Feature 失败日志接入与真实环境错误注入验证。
- **建议处理阶段**：Phase 4E-2A / Phase 4E-2B。
- **后续设计方向**：可评估由 Generation Core 在错误对象中附带经过安全处理的结构化请求上下文，例如 URL、model、messages 数量、是否 stream、HTTP status，以及可安全记录的请求体摘要；不在本观察项中确定最终 API 设计。
- **最终关闭记录**：
