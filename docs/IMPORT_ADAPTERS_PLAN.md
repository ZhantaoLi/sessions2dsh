# 多来源会话导入计划

状态更新（2026-10-29）：CodeBuddy CLI 首版已实现并完成隔离验证，限制与证据见 [CodeBuddy 实施记录](CODEBUDDY_IMPLEMENTATION.md) 及 README。Codex 仍为规划。以下保留总体设计目标，部分能力（真实压缩、复杂排队等）尚未实现，不能据此视为当前支持承诺；未向真实 dsh 导入 CodeBuddy 会话。
日期：2026-10-29。目标仍为 dsh，工具保持轻量命令行、Node.js、无需新增 npm 依赖。

## 已核对的现状

已阅读项目 README、迁移与清理记录，以及来源读取、转换、批量执行、附件和持久化实现；只读检查来源日志的类型与字段，未输出对话正文或凭据。

| 来源 | 可见样本 | 观察到的格式 | 尚待核对 |
|---|---|---|---|
| Claude Code | 既有适配器和真实迁移记录 | projects 下 JSONL，已实现原生 dsh 导入 | 保留旧 ID、事件前缀和清单兼容性 |
| Codex | sessions 下 74 个 JSONL，archived_sessions 下 1 个 | session_meta、response_item、event_msg、turn_context、compacted；样本含多个 CLI 版本 | 分支/继承、活动线程、压缩替换、工具与附件的版本差异 |
| CodeBuddy | ~/.codebuddy/projects 下 50 个 JSONL；sessions 目录为空 | message、reasoning、function_call、function_call_result、summary、session-meta | CLI/IDE 差异、summary 的实际生效范围、主/子会话标识与外部工具结果 |

这些是文件数量，不是可直接导入的主会话数量。Codex 有明确子代理来源，也发现 4 份文件包含多个不同身份的 session_meta；需要检查是否属于继承/拼接，不能直接取第一个或最后一个 ID。CodeBuddy 有纯 session-meta 文件及混合 sessionId 文件；meta 中 mainAgent 是字符串等多种值，不能当作主/子代理布尔标志。

本轮优先范围为实际可见的 Codex rollout 格式与 CodeBuddy projects 格式。不把 CodeBuddy CLI、IDE、国际版/国内版默认视为相同存储协议；其他变体待发现实际样本后另列格式配置。

## 实现边界

- 先支持更多来源导入 dsh；暂不扩展为任意目标互转、实时同步或动态来源插件市场。另行规划的 [dsh 插件入口](DSH_PLUGIN_PLAN.md)复用此处核心，首版采用人工命令，页面可选。
- 默认主会话；子代理只有 --include-subagents 才纳入。无法可靠判断身份时明确报告待确认，不静默混入主会话。
- 默认只读预检；--write 才发布。发现未知记录时区分仅影响展示的元数据与影响对话/活动上下文的必需记录，后者预检失败。
- 来源不修改，不执行历史工具，不自动发模型请求，不继承旧会话的沙箱/权限/系统级控制配置。
- 密文思考、签名等不可重建内容只保留原件并注明；不解密、不补写虚构思考。
- 保留批量部分失败继续、原件备份、SHA 校验、幂等、目标续聊前缀校验和显式未知结果恢复。

## 分层设计

采用内置静态适配器，不引入插件框架：

```text
Claude / Codex / CodeBuddy 来源适配器
  -> 中间会话表示与校验
  -> dsh 原生事件构造
  -> 公共备份、发布、附件、验证、批量报告
```

来源适配器提供 discover、probe、read/normalize：发现来源、识别格式、解释该来源的时序和上下文语义。备份文件集合、外部依赖、来源定位、主子关系和格式能力随结果返回，不能继续假定所有来源只有一个 source.jsonl。

中间表示至少包含：

- 来源产品/变体、格式版本、逻辑会话身份、可证实的父子/继承关系。
- cwd、标题、创建时间和模型来源；未知字段明确为空，不从当前设置补造历史事实。
- 用户/助手正文、可读思考、工具调用/结果、附件引用、轮次及中断。
- 原始 transcript 与活动模型上下文分别表示；压缩/编辑记录表达为带依据的替换操作，而非扁平拼接全部历史。
- 来源定位（文件、行号或事件 ordinal、原消息/调用 ID）与转换说明、跳过原因、阻断问题。

通用层输出 dsh 的完整生命周期与受保护 system head，附件仍通过已验证的原生 API。适配器处理来源特有关系，不把 Codex / CodeBuddy 先改造成假的 Claude JSONL。

Claude 兼容性单独保护：维持已发布会话的确定 ID、消息 ID 和事件字节前缀。先保留旧 Claude 转换路径作为兼容实现，待新中间表示能够通过等价性检查后再迁入公共构造器；不得因重构导致现有主会话冲突或重复。转换版本记录在 manifest，不随升级任意生成新身份。

## 阶段与交付

### 1. 来源盘点与格式契约

对两种来源生成只含结构和计数的诊断报告：有效逻辑身份、格式变体、主/子/未知、归档、分支/继承、压缩、附件、缺失结果、活动写入和仅元数据文件。扫描时保留结构错误行号，并检测文件变化。

为每种实际格式建立少量脱敏合成 fixture，覆盖旧/新版本及已发现的多身份文件。外部工具结果与图片仅从已验证的本地引用读取，不自动下载 URL，不把凭据配置目录当作会话数据。

交付：支持矩阵与计数报告；确认每类记录如何影响 transcript 和后续模型输入。不能准确重建的格式列为阻断，不能以“已备份”冒充“已导入”。

### 2. 公共流程与来源选择

把 manager/batch 中直接调用 Claude 的位置改为适配器选择，提取真正通用的来源快照、映射、发布和校验。建立 manifest 新版并继续读取旧版。

保留现有命令习惯，拟定接口如下（尚未实现）：

```bash
node bin/sessions2dsh.mjs list --from codex
node bin/sessions2dsh.mjs preview /path/to/rollout.jsonl --from codex
node bin/sessions2dsh.mjs batch --from codex --report report.json
node bin/sessions2dsh.mjs batch --from codebuddy --write --app
node bin/sessions2dsh.mjs batch --from codebuddy --include-subagents --write
```

--from 扩展到 list/preview/import/batch；不传时保持 Claude 兼容默认。--source-root 指定所选来源根目录，--claude-root 保留兼容。自动识别只在签名唯一时使用，歧义要求显式来源。先不加入隐式“扫描所有来源并写入”的命令。Codex 归档单独以 --include-archived 纳入，默认不导入归档。

来源读取与 list 不依赖已安装 dsh；真正的 dsh 预检/发布才加载目标运行时。

交付：Claude 原有回归通过，既有正式清单只读核对仍兼容；来源选择失败不会产生任何目标写入。

### 3. CodeBuddy / Codex 适配阶段

按最小可用版成本，推荐先 CodeBuddy、再 Codex；下列分项按来源列出，不代表实现先后。两者的压缩与身份歧义均需单独验证，不能因顺序而跳过。

#### Codex 适配器

Codex 的适配要点：

- 以 rollout 结构中的会话身份及关系为准；history.jsonl/session_index/SQLite 只作为发现、标题或关系线索，不当作完整对话原件，也不写回 Codex 数据库。
- response_item 作为持久消息/工具事实的主要候选来源，event_msg 用于回合完成、中断和必要展示信息；对重复叙述去重，不能同时导入两份助手回复。具体取舍按版本 fixture 验证。
- 支持 function_call/output、custom_tool_call/output；自定义工具原始字符串输入保留其格式，不能假设均为 JSON 对象。web_search_call、tool_search_call/output、additional_tools 等建立各自映射或明确阻断，不静默跳过。
- 可读 reasoning summary 按来源标为可读摘要；encrypted_content 仅备份。区分真实用户消息与工作区/开发者注入，避免把旧权限提示自动提升为 dsh 执行权限。
- turn_context 保留可验证的模型、cwd 和回合关联；compacted/replacement_history 还原活动上下文替换，同时保留原始 transcript。
- 分叉继承和重复 session_meta 按证据拆分/去重；活动尾部不发布为完整会话。只读稳定快照导入不冒充实时同步。

交付：短文本、工具历史、可读摘要、压缩、子代理排除、继承和中断等样例通过隔离原生读回。再选择一个已结束主会话进行真实 dsh 验证，之后才安排批量。

#### CodeBuddy 适配器

- 单独解释顶层 message/role/content、reasoning、function_call/callId/arguments、function_call_result/output；保留 input_text/output_text 和时间顺序。
- 调查 parentId 与 session-meta 的真实用途，正确处理分支、仅元数据文件及多 sessionId；不要借用 Claude 的 parentUuid 或子代理判断。
- 调查 summary 的替换边界和 providerData 证据；若只有摘要文本而无法证实旧消息退出范围，不宣称可准确续聊，可先阻断该类或另行设计明确标注的仅历史导入模式。
- 工具结果旁路文件（含 tool-results）作为来源快照的一部分核对与备份；原始输出与渲染用副本分开识别。路径可能来自 Windows/WSL，不依据当前目录猜测映射，需要 --cwd 或显式路径映射规则。
- CLI / IDE、不同版本各有独立 probe；未知变体先列出诊断，不猜路径后自动写入。

交付：独立合成 fixture 和真实已结束主会话的隔离/应用验证。若某类格式尚不能准确还原，其失败不阻断其他可支持会话，但报告必须逐条列明。

### 4. 验收与文档

各来源执行同一套验证：预检无副作用、完整快照校验、确定 ID、跨来源 ID 不碰撞、重复导入跳过、已续聊目标前缀保留、来源变化拒绝、部分失败继续、默认排除子代理、未知语义拒绝、dsh 冷态读回与应用列表/历史一致。

新增来源使用自己的来源命名空间；Claude 已有身份规则冻结。备份/清单带来源产品、格式和转换版本，以及多文件摘要；统计区分 discovered/skipped/blocked/imported/duplicate，纯元数据或归档排除有明确原因。

最终更新 README 的支持版本、限制、用法和验证环境。真实批量导入属于后续执行工作，本计划不启动导入、删除、重启服务或修改来源数据。

## 推荐顺序

来源盘点 -> 最小公共流程 -> CodeBuddy 单会话 -> Codex 单会话 -> 根据预检报告决定批量。dsh 插件入口可先用已支持的 Claude 验证，与来源适配分开推进；新的目标格式仍在范围之外。
