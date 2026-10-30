# CodeBuddy CLI 实施记录

日期：2026-10-29。按已确认的多来源计划优先实现 CodeBuddy，插件暂停。

## 范围和设计

保留零依赖 Node.js CLI 与 Claude 既有转换路径。新增独立 CodeBuddy projects JSONL 读取器及来源选择层；CodeBuddy 直接生成通用原生消息表示，再交给 dsh 事件构造器，不转成 Claude JSONL。CLI 新增 `--from codebuddy`、`--source-root`，默认仍为 Claude。

首版支持文本、可读思考、并行工具与完整工具结果；通过 providerData 的 request/message/step 证据合并助手记录。读取原始 arguments 字符串，保留空白。默认不纳入 subagents，显式选项可纳入，身份不明或混合则报错。summary 的 initial-user-message/periodic/pre-compact 属于列表摘要（CodeBuddy 2.178.0 的 SummaryService 和 MessageContentUtils 已核对），只备份；真正 compact flags 的边界另行验证，首版阻断。

工具结果外置文本只接受来源会话自己的 tool-results 目录，经 realpath 边界检查，纳入快照、发布前复核和备份验证；缺失时拒绝发布。未知块、未知影响上下文的事件、孤立结果及分支不静默丢弃。局部错误不阻止批量邻居。

## 执行清单

- [x] 新增 CodeBuddy 合成回归，先验证现有实现失败：来源选择、模型步合并、原参数和工具结果、原生读回与幂等、默认子代理排除。
- [x] 实现 `src/codebuddy.mjs`、`src/native.mjs` 与来源选择，保留 Claude ID/前缀。
- [x] 加入外置结果、压缩/未知记录拒绝、快照备份与续聊校验测试，验证失败后实现。
- [x] 接入 list/preview/import/batch/doctor 与 help；验证错误来源不写入。
- [x] 运行全套回归、只读批量预检和隔离导入/重复验证，记录明确限制与命令。

## 验收和复盘

- 原流程只解析 Claude 形态，无法读取 CodeBuddy 分离的 reasoning/message/call/result。本轮增加独立语义读取器和新来源原生构造器，未修改 Claude 转换器。
- `npm test`：44 项通过（原 27 + CodeBuddy 17）。新功能先用合成测试复现失败，再实现。覆盖原参数、并行调用、错误结果、幂等、外置结果/来源变化/备份篡改、无写入预检、子代理身份冲突、压缩/未知块、提醒角色和系统提示更新后冷恢复。
- 以修改前代码对照 Claude 来源完成只读回归：既有主会话的 header/events 完全一致，新出现的无正文来源前后都拒绝。
- 隔离验证通过：默认范围只纳入主会话，空文件、纯元数据及本地命令跳过，没有创建空目标；重复执行零新增。
- 最终阻断项包括缺失外置结果、真实压缩和模型步骤穿插；后两类不自动扁平化。
- 审查补齐无标记旧压缩信封、truncated/discard 语义、secondary reasoning 未知块、本地错误未知块及子代理路径/布尔标志冲突；均已加入回归。
- CLI 的 `--expect-snapshot-sha` 在预检后约束 JSONL 与外置结果，避免只锁 JSONL 时遗漏旁路变化；`--expect-sha` 继续保持旧语义。

可复现隔离命令（示例路径，按需替换）：

```bash
node bin/sessions2dsh.mjs batch --from codebuddy \
  --target-root /path/to/stage/sessions --data-dir /path/to/stage/data \
  --write --report report.json
```

## 限制

只验 CodeBuddy 2.178.0 projects 格式与 dsh 0.2.1-rc.2/v4。未知语义拒绝；CodeBuddy 图片/文件、真实压缩、复杂排队/分支和自动路径映射尚未实现。插件暂停，Codex 未实现。
