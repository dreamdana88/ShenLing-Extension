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

* **当前状态**：已关闭。
* **最终关闭记录**：关闭阶段：Phase 4E-2C、Phase 4E-2D 与 Phase 4E-2E Final Audit；副 API 完整 timeout / cancellation 实现提交：`4ebb3e706e5e921ae4eabfa18cac5ae96ce7846e`；AbortController 浏览器实机验收基线 HEAD：`d6625204d773b3713a23291a700b798526dd7b3e`；Schedule timeout 调整提交：`e0376fdb3f49ec75d7edfa3f0d5d5d67cca7e71e`；Phase 4E 最终收尾提交：`9f86b3c1cb866a3c5f51b92c61dd56191e80b0d1`。验证结论：副 API timeout 已覆盖等待响应头与读取响应正文，并能通过 AbortController 真实取消请求；主 API继续保持 wait-only；Schedule timeout 已由 180 秒调整为 300 秒，主、副 API提示语与真实行为一致；Chrome 实机验证中响应头前和正文读取阶段均正确返回 `SECONDARY_TIMEOUT`，连接取消证据成立；0.17.16 最终冒烟中主、副 API成功路径均通过。关闭日期：2026-07-28。

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

* **当前状态**：已关闭。
* **最终关闭记录**：关闭阶段：Phase 4E-2A 至 Phase 4E-2E Final Audit；Generation Transport Error 契约提交：`bfbddb74da893622ea48987736d597e528116ade`；七个 Generation Feature 失败日志接入提交：`89601ea8394e8953d6f8d61173eab22e78cf655e`；副 API timeout / cancellation 实现提交：`4ebb3e706e5e921ae4eabfa18cac5ae96ce7846e`；AbortController 浏览器实机验收基线 HEAD：`d6625204d773b3713a23291a700b798526dd7b3e`；Phase 4E 最终收尾提交：`9f86b3c1cb866a3c5f51b92c61dd56191e80b0d1`。验证结论：七个直接 Generation Core 调用方均已接入 `getGenerationErrorContext()`；Core 返回前失败可取得稳定的 code、stage 与白名单 diagnostics；原始 cause 保留；Affection 失败日志中的 messages 丢失已修复；Feature parser、preflight 与 Summary 非 JSON错误继续保持 Feature Error 边界；自动测试、敏感信息测试、Chrome cancellation 实机验证及 0.17.16 主、副 API成功冒烟全部通过，日志未显示 API Key、Authorization、完整 Profile 或 cause 对象。关闭日期：2026-07-28。

## OBS-007

* **来源 Phase**：Phase 4E-2A GitHub 实际提交审查。
* **当前状态**：已关闭。
* **现象或能力边界**：当 `globalThis.generateRaw` 不存在，且 `globalThis.SillyTavern.getContext()` 自身抛错时，旧实现会直接向上抛出普通 Error，无法通过统一 Generation Error 访问器取得稳定错误上下文。
* **最终处理**：Phase 4E-2E 在 Generation Core 中增加 `MAIN_PROVIDER_RESOLUTION_FAILED`，stage 为 `resolve_provider`。Provider 解析异常现在会包装为 `GenerationTransportError`，保留原始 cause，并提供仅包含 `provider`、`messageCount` 与 `durationMs` 的安全 diagnostics。正常 Provider 优先级保持为全局 `generateRaw` 优先；全局入口存在时不会调用 `SillyTavern.getContext()`；`getContext()` 正常返回但不存在 `generateRaw` 时继续使用 `MAIN_PROVIDER_MISSING`；任何解析失败均不会 fallback 到副 API。
* **最终关闭记录**：关闭阶段：Phase 4E-2E；实现提交：`9f86b3c1cb866a3c5f51b92c61dd56191e80b0d1`；版本：`0.17.16`；验证结论：隔离测试已复现旧行为并验证新错误契约、Provider 优先级、cause 保留、敏感信息清洗与无 fallback；GitHub 实际提交审查通过；SillyTavern 1.18.0 实机确认 `globalThis.generateRaw` 可以为 `undefined`，实际主 Provider 可通过 `SillyTavern.getContext().generateRaw` 正常取得；0.17.16 主 API与副 API成功冒烟均通过，未出现新增 Generation、模块或未处理 Promise 错误。关闭日期：2026-07-28。
