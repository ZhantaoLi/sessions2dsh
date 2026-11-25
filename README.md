# sessions2dsh

Import other agents' session history into DeepSeek Harness.

把 **Claude Code / CodeBuddy / Antigravity（agy）** 的历史对话导入为 **DeepSeek Harness（dsh）原生会话**，可在应用里查看和继续使用。轻量 CLI，无需为本工具安装 npm 依赖。

## 环境要求

- Node.js **24+**。
- 已安装 **`@deepseek-ai/dsh`**，且其会话格式为 v4（在 `0.2.2-rc.5` 上验证过；不锁版本，格式不符才拒绝）。Windows 若仅安装了 Desktop 版（运行时打在 `app.asar` 内），需另备一份独立 `@deepseek-ai/dsh` npm 包并通过 `--runtime` 或 `DSH_PACKAGE_ROOT` 指定。

## 快速开始

```bash
git clone https://github.com/ZhantaoLi/sessions2dsh.git
cd sessions2dsh
node bin/sessions2dsh.mjs doctor

# 默认来源：Claude Code
node bin/sessions2dsh.mjs list
node bin/sessions2dsh.mjs preview /path/to/session.jsonl
node bin/sessions2dsh.mjs import /path/to/session.jsonl --write
```

默认只预览，**加 `--write` 才实际导入**。来源文件不修改，历史工具不执行，也不自动请求模型。

CodeBuddy 使用 `--from codebuddy`，Antigravity（agy）使用 `--from agy`（别名 `antigravity`）：

```bash
node bin/sessions2dsh.mjs list --from codebuddy
node bin/sessions2dsh.mjs import /path/to/session.jsonl --from codebuddy --write

node bin/sessions2dsh.mjs list --from agy
node bin/sessions2dsh.mjs import ~/.gemini/antigravity-cli/brain/<id> --from agy --write
```

## 批量导入

```bash
# 先预检并查看报告
node bin/sessions2dsh.mjs batch --report tmp/import/preflight.json

# 确认后导入；CodeBuddy 添加 --from codebuddy，Antigravity 添加 --from agy
node bin/sessions2dsh.mjs batch --write --report tmp/import/result.json
```

默认仅主会话；加 `--include-subagents` 才导入子代理。一条失败会继续处理其余会话，报告保留每条结果。

## 导入前须知

- **自动备份与去重**：来源备份和清单默认保存在工具目录的 `data/`。重复导入跳过相同历史，不覆盖目标续聊；源会话增长后默认报错保护，加 `--update` 可在未分叉时原地追加增量事件（发生分叉/历史改写时默认跳过，加 `--on-conflict new` 按当前快照确定性新建会话）。
- **工作区**：正常保留原 `cwd` 并登记分组；目录缺失或无效时，改用 dsh 默认工作区。已有导入会话不自动重新分组。
- **应用刷新**：出现“请重启 DeepSeek Harness 应用”时，先重启再在界面移动、置顶或归档，避免旧状态覆盖新分组。
- **部分成功**：历史已导入但分组或验证失败时，仍返回非零退出码；按错误提示重试，已导入历史会保留。
- **支持边界**：CodeBuddy 仅验证过 CLI 2.178.0 的 projects 格式，暂不支持图片/文件、真实压缩和复杂分支；Antigravity（agy）读取 `brain/<id>/.system_generated/logs/transcript_full.jsonl` 与同级只读 `conversation_summaries.db`，支持本地图片附件与多文件快照校验，运行中会话与 `CHECKPOINT` 压缩默认阻断（可加 `--best-effort` 降级保留）。Codex 导入及 dsh 插件尚未实现。

默认读取 `~/.claude/projects`、`~/.codebuddy/projects` 或 `~/.gemini/antigravity-cli`，写入 `$DSH_HOME/sessions`（未设置时为 `~/.dsh/sessions`）。自定义目录、应用验证、置顶、快照锁定和转换规则见 [完整用法](docs/USAGE.md)。

## 更多

```bash
node bin/sessions2dsh.mjs --help
npm test
```

[使用说明](docs/USAGE.md) · [开发说明](docs/DEVELOPMENT.md)
