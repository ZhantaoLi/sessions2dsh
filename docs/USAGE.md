# 使用说明

## 单会话与验证

环境与首次上手见 [README](../README.md)。以下命令在项目根目录执行：

```bash
node bin/sessions2dsh.mjs doctor
node bin/sessions2dsh.mjs list --project my-project
```

列表会显示源文件的绝对路径。选择一个已结束的主会话：

```bash
# 只读预览，不写目标，也不创建备份
node bin/sessions2dsh.mjs preview /path/to/session.jsonl

# 查看转换后的全部消息（可能包含很长的工具结果与思考）
node bin/sessions2dsh.mjs preview /path/to/session.jsonl --messages

# 实际导入：新增原生会话并保存来源备份
node bin/sessions2dsh.mjs import /path/to/session.jsonl --write

# 核对应用列表/历史，同时在原生注册表置顶（应用重启后显示）
node bin/sessions2dsh.mjs import /path/to/session.jsonl --write --app --pin

# 用上一步输出的 ID 验证，允许目标会话已经继续对话
node bin/sessions2dsh.mjs verify session-xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx --app

# 也可以查看现有 dsh 会话头信息
node bin/sessions2dsh.mjs list --from dsh
```

`import` **省略 `--write` 时只预览**。所有命令支持 `--json`；错误输出到 stderr，退出码为 1。历史已写入、但工作区登记、置顶或应用验证失败时，退出码仍为 1，结果的 `ok` 为 `false`，分别在 `workspace`、`pin`、`application` 字段说明；原生历史保持有效，可重试同一命令。文本输出会显示分组或置顶失败的原因。

完整选项：

```bash
node bin/sessions2dsh.mjs --help
```

## 常用选项

| 选项 | 用途 |
|---|---|
| `--title '标题'` | 导入标题；默认从第一条用户正文生成，前缀 `[Claude]` |
| `--cwd /absolute/path` | 覆盖工作目录；默认保留源会话目录 |
| `--workspace-sync` | 使用自定义目标根时启用 dsh 工作区登记；异常 cwd 改写为默认工作区 |
| `--expect-sha SHA256` | 要求源文件与预览输出的 SHA256 一致，避免审阅后来源变化 |
| `--claude-root /path/to/projects` | 指定 Claude projects 目录；也尊重 `CLAUDE_CONFIG_DIR` |
| `--from codebuddy` | list/preview/import/batch 选择 CodeBuddy；省略仍为 Claude |
| `--source-root /path/to/projects` | 指定所选来源根目录；CodeBuddy 默认 `~/.codebuddy/projects` |
| `--expect-snapshot-sha SHA256` | 单会话锁定 JSONL 与外置结果的完整快照；CodeBuddy 预览会显示该值 |
| `--dsh-home /path/to/.dsh` | 指定 dsh home；也尊重 `DSH_HOME` |
| `--target-root /path/to/sessions` | 单独指定原生会话存储，可用于隔离试验 |
| `--data-dir /path/to/data` | 指定来源备份和导入清单目录 |
| `--runtime /path/to/@deepseek-ai/dsh` | 指定已有 dsh 安装，不下载任何代码 |
| `--app-log /path/to/launcher.log` | 指定 dsh Web 启动日志；认证数据仅留在内存中 |

覆盖工作目录会改变应用之后执行任务的起始目录。它不会移动原项目文件。使用默认 dsh 根目录时，工具会为新导入会话登记 cwd 对应的工作区；cwd 不存在或不是目录时，清单保留 `originalCwd`，但新会话头部改写为 dsh 注册表中的默认工作区，以便应用分组。已有导入记录和现有 Claude 会话不会因重跑而整理。使用自定义 `--target-root` 时默认关闭工作区同步，可加 `--workspace-sync` 显式启用，并确保 `--dsh-home` 指向对应的 dsh 根目录。应用列表在冷态首次出现时可能尚无标题缓存，`--app` 会通过原生投影读取进行校验；`--pin` 可使其容易找到。刷新 dsh 界面后按标题或 ID 查找。

如果异常 cwd 且 dsh 注册表没有可用默认工作区，预览会失败，不会写入一个无法分组的会话。工作区注册通过 dsh 的 `WorkspaceRegistry` API 完成；预览只读 `workspace.json`，不会创建工作区或目录。

工作区登记是**写注册表文件**，而运行中的 dsh Web 在启动时读取该注册表、之后不回读（存储后端不监听文件变化），所以**导入后需要重启 `dsh web`（并刷新界面）才能看到新的工作区分组**；重启前界面仍显示“未分组”。因此：只要本次导入登记了工作区、且检测到本机 dsh Web 正在运行，单条 `import` 会在结果 `warnings`、批量 `batch` 会在报告 `warnings` 中提示“请重启 DeepSeek Harness 应用”。`--app` 验证只核对 `session/list` 与 `session/page` 历史前缀，**不覆盖工作区归组**。重启前若在界面里做工作区写操作（重命名/移动/置顶/归档），旧的内存文档可能被整体写回、覆盖新登记的成员关系：请先重启再操作。新建工作区的标题默认取目录末级名；若与已有工作区同名，自动改用“末级（上一级目录名）”，仍冲突则继续逐级上溯（例如 `/srv/alpha/team/project` 在已有 `project` 时登记为 `project (team)`）。

`--pin` 通过 dsh 原生 `WorkspaceRegistry` 读取最新磁盘注册表并置顶，不向运行中应用发送工作区写请求，避免应用旧状态覆盖新分组。置顶结果在 `pin` 字段返回；它仍隐含 `--app` 的只读历史验证，使用时需要可连接的本机应用。应用重启后再检查分组和置顶。没有工作区登记或新的置顶变更时，不提示重启。

## 批量导入

**默认只列出、导入主会话。子代理为可选项，只有加 `--include-subagents` 才会纳入批量导入。**

```bash
# 所有主会话；省略 --write 仅预检
node bin/sessions2dsh.mjs batch --report tmp/bulk-import/preflight.json

# 默认用法：只导入主会话，再通过本机应用 API 验证
node bin/sessions2dsh.mjs batch --write --app \
  --report tmp/bulk-import/report.json

# 来源确有缺失结果时才显式启用恢复标记
node bin/sessions2dsh.mjs batch --repair-interrupted --write --app \
  --report tmp/bulk-import/report.json

# 可选：同时纳入子代理
node bin/sessions2dsh.mjs batch --include-subagents --write --app \
  --report tmp/bulk-import/report-with-subagents.json
```

单会话 `import <路径>` 只处理显式指定的文件；不会连带导入它的子代理。

批量共用原生存储连接；每个会话单独预检、备份、写入、读回和校验附件，一条失败继续下一条。历史导入成功但分组失败的条目仍计入 `imported` / `existing`，同时计入 `workspaceFailed`，报告 `ok: false` 并返回退出码 1。报告每完成一条就原子更新，记录成功、重复、失败、工作区登记失败和应用验证错误；重新执行相同命令可跳过已导入前缀。批量不自动置顶，支持 `--project` 筛选，不接受单会话 `--title` / `--expect-sha`。`--report` 是显式写报告，即使未加 `--write` 也会生成该报告，不写目标或来源备份。

工作流 `journal.jsonl` 是调度日志，不当作对话创建空会话；导入其主会话时，将这些文件逐字节备份到清单目录 `auxiliary/`，用 `auxiliary.json` 保存来源及 SHA256。`--include-subagents` 才会额外创建子代理会话。

使用 `--target-root` 隔离试验时，图片默认位于该目录旁的 `attachment-home/`；真实导入应省略该选项，使用已配置的 dsh home，保证应用能解析附件。

## 数据和重复导入

工具只新增目标会话，不修改来源，不覆盖目标历史。目标 ID 从来源产品和 session ID 稳定派生，同一会话的文件副本不会产生新的 ID；不同来源不会共用目标身份。Claude 原有 ID 规则保持不变。

写入前先完成转换和原生 Session 校验，然后在 `data/imports/<目标根路径摘要>/<session-id>/` 保存：

```text
manifest.json  来源路径与 SHA256、版本、消息映射、跳过记录和转换说明
source.jsonl   完整来源备份（包括没有转成对话的 Claude 运行元数据）
events.json    确切的原生事件前缀；消息 ID、时间和流记录均可重复生成
```

文件默认仅属主可读写。`data/` 被 git 忽略，不要把私有会话当成代码提交。manifest 的 `prepared` 表示备份已经落盘，`published` 表示原生写入并读回成功。

- 重复导入相同来源时，只有目标头与导入前缀完全一致才跳过写入。
- 目标已经在 dsh 续聊、改名或切换设置，只要历史前缀仍一致，就正常通过验证；后续事件完整保留。
- 源会话继续增长、显式标题/cwd 选项与记录冲突或已有目标前缀不同，会报冲突，**不会覆盖，也不会自动同步**。
- 完整备份在原生写入之前生成。写入失败应保留备份；不要把“来源备份存在”误认为目标已成功发布。
- 同一备份槽用 `import.lock` 防止并发写入。若进程被强制终止，核对锁中的 PID，确认该进程已结束后，才能手动移除该锁并重试。目标已完整发布、清单尚为 prepared 的情况可重试；不完整目标会明确报冲突，需要先诊断。
- `verify` 检查备份校验和及目标原始前缀；原来源已增长时报告 `sourceState: changed`，不会修改目标或备份。

此前临时脚本采用另一种 ID 规则，可用 `--reuse-receipt /path/to/trial-manifest.json` 核对来源 SHA、目标 cwd/起始时间与全部原始消息载荷，再登记已有目标。若旧目标恰好是已验证的“缺少首个 system surface 节点”损坏情况，则通过系统 `zstd` 只读解出完整日志，保留续聊，新建修复后的确定 ID 会话；不改写旧文件。备份目录额外保存原生压缩原件。恢复登记后可直接从已校验的正式备份重试，不再依赖旧临时凭据或旧目标文件；首次恢复需要系统已有的 `zstd` 命令。其他损坏拒绝自动修复。新导入会预置空系统节点及合法生命周期，支持后续系统提示更新和冷态恢复。

## 转换范围

本节以下 Claude 规则保持原有语义。CodeBuddy 的独立规则见下一节。

支持用户文本、助手文本、thinking → reasoning、历史工具调用及其结果；同一 assistant message ID 的连续记录合并为一个模型步骤。工具调用与结果保留原 call ID、参数和内容，导入时**不执行工具**。`tool_reference` 转成带原字段的 JSON 文本，并在预览和清单中说明。

Claude 本地 `/model` 等命令、meta prompt、运行配置、文件快照和目录清单等元数据只保存在来源备份中，不作为新的用户对话注入 dsh。原模型名称保留，来源标为 `claude-code`；Claude Code 历史不一定由 Anthropic 模型生成。

已支持并记录转换明细：

- 内嵌 base64 图片由 dsh 原生附件 API 在内存解码、校验和规范化，预览不写盘；实际导入在 `<dsh-home>/attachments/v1/` 持久化不可变图片并读回校验。原始图片仍完整留在 source.jsonl，模型使用 dsh 规范化版本。不自动下载外部图片 URL。
- 压缩摘要在保留 UUID 清单可验证时，通过 native surface replacement 替换旧模型上下文，旧正文与工具历史仍在 transcript。缺失清单、未知引用或不合法的保留范围会拒绝；清单中的已知本地命令与计时元数据仅在原件中保留。按来源清单保留相应后缀及触发压缩的待答问题；不把完整旧历史重新塞入续聊上下文。
- 兼容接口复用 message ID 时，工具结果仍分隔独立模型步骤。完成后复用的 tool call ID 按出现次数改为确定唯一 ID，并同步匹配对应结果。
- 回复前修改提问时，旧、新提问都保留在 transcript，旧提问退出活动上下文。排队提问穿插并行工具结果时，先结算已有结果再开始新轮次，来源行号与时间保留，重排写入清单。
- 独立子代理文件按父 session ID + agent ID 生成独立目标；清单保留父来源 ID，标题有“子代理”标记。包括 workflows 子目录。不会伪造仍在运行的 dsh 委派任务或父子任务树。

以下情况明确拒绝：非法 UTF-8、未知内容块、document/redacted thinking、未独立标识的 sidechain、已经有回答的兄弟分支、无法验证保留范围的压缩、未完成调用 ID 冲突、孤立工具结果、损坏或混合 session ID 的 JSONL。

缺失工具结果默认拒绝。显式使用 `--repair-interrupted` 时，生成带 `[Claude import recovery]` 标记的错误结果，明确说明源记录缺失、结果未知、有副作用的操作应先核实状态。不会伪造成功输出或执行旧工具。没有助手回复的用户轮次按 interrupted 保留。

原 token 边界、精确耗时、Claude thinking 签名、模型缓存及用量无法忠实迁移；工具重建可读的流，不伪造这些统计。`--app` 验证应用 API，不等同于 UI 自动点击或模型续聊测试，也不会自动发消息、执行模型请求或修改现有权限。

## CodeBuddy CLI

支持本机 **CodeBuddy 2.178.0 的 `projects` JSONL**。CLI 保持零依赖；不将 IDE、国内版或其他版本的日志默认视为相同协议。

```bash
node bin/sessions2dsh.mjs list --from codebuddy
node bin/sessions2dsh.mjs preview /path/to/session.jsonl --from codebuddy --messages
node bin/sessions2dsh.mjs import /path/to/session.jsonl --from codebuddy --write --app

# 先预检；仅显式 --report 会写诊断报告
node bin/sessions2dsh.mjs batch --from codebuddy --report tmp/codebuddy/preflight.json

# 审阅报告后执行；默认排除子代理
node bin/sessions2dsh.mjs batch --from codebuddy --write --app --report tmp/codebuddy/import.json
```

支持用户 `input_text`、助手 `output_text`、可读 `reasoning_text`、并行 function_call/result。通过 request/message/step 证据合并同一次模型输出，完整保留工具参数字符串（包括空白）、输出及错误状态；不执行旧工具。模型名来自原记录，不从当前模型设置猜测。`mainAgent: "ptc"` 等字符串不是子代理标志；子代理路径与显式布尔标志冲突时拒绝导入。

`summary` 中已核对的 `initial-user-message`、`periodic`、`pre-compact` 是列表摘要，仅备份。真正 compact flags、旧 `<cb_summary>` / `<conversation_history_summary>` 信封、truncated/discard 上下文淘汰标记暂时阻断，避免恢复错误上下文。模型注入的提醒按原 user 角色放入当前轮次；本地命令只备份，不伪造新提问。缺少模型信息的本地 API 错误只留原件并显示警告，不能算作成功模型回答。

`<persisted-output>` 指向的完整文本会导入，同时逐字节备份至导入目录 `external/`，在 manifest 的 `sourceFiles` 中记录路径与 SHA。只读取当前来源会话自己的 `tool-results` 目录，检查 realpath 和 UTF-8；不会自动映射跨机器路径、下载内容或使用截断预览掩盖缺失文件。`verify` 同时校验这些备份及原来源状态；审阅后锁定整个多文件快照应使用 `--expect-snapshot-sha`，`--expect-sha` 仍只锁定 JSONL。

空文件、纯元数据及仅本地命令文件在批量中记为 `skipped`，不创建空会话。未知记录、内容块、混合身份、不能确认的父链或模型步骤穿插均逐条失败并继续邻居；存在失败时退出码仍为 1。图片/文件内容块、复杂排队与分支、真正压缩暂未支持。只对稳定快照做一次导入，不自动同步活跃来源。

覆盖面实测（CodeBuddy 2.178.0 projects）：默认扫描 49 份（排除 1 份子代理），14 个可导入、31 个跳过、4 个阻断。隔离验证完成 14 个会话、4,951 条事件、909 次工具调用、1 份外置结果的原生导入/备份/冷读，重跑全部识别为重复。阻断项为外置结果缺失、真实压缩和模型步骤穿插，未靠恢复选项跳过；31 个跳过来自空文件、纯元数据与仅本地命令文件，不会创建空会话。实施记录见 [CODEBUDDY_IMPLEMENTATION.md](CODEBUDDY_IMPLEMENTATION.md)。
