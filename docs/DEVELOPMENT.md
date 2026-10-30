# 开发说明

本工具不需要 `npm install`。开发和测试仍需要 Node.js ≥24，以及已安装的 `@deepseek-ai/dsh 0.2.1-rc.2`。

```bash
npm test
node bin/sessions2dsh.mjs doctor
```

测试使用合成来源与 dsh 原生后端，数据放在项目 `tmp/tests/`，各测试自行清理；不写真实 dsh home，不发起模型请求。权限失败用例在 Windows 或 root 环境跳过。

Commit message 使用简短英文；改动经用户确认后再提交。

## 代码结构

```text
bin/sessions2dsh.mjs  命令行解析、中文输出和 JSON 接口
src/claude.mjs          发现与读取 Claude 会话，检查可转换结构
src/convert.mjs         转换为确定的 dsh 事件及来源映射
src/codebuddy.mjs       CodeBuddy 发现、记录语义与原生消息归一化
src/sources.mjs         内置来源适配器选择
src/native.mjs          新来源共用的 dsh 原生生命周期构造器
src/snapshot.mjs        多文件来源快照与外置结果备份验证
src/runtime.mjs         定位现有 dsh 运行时与挂载原生持久化
src/workspace.mjs       dsh 工作区匹配、异常 cwd 回退与新会话登记
src/manager.mjs         预览、备份、写入、重复检测和验证
src/app.mjs             可选的本机 dsh 应用 API 验证
src/batch.mjs           批量执行、续跑、部分失败报告和工作流日志备份
src/attachments.mjs     图片预检、原生附件发布与完整性校验
src/legacy.mjs          已审阅旧凭据登记和特定系统头故障恢复
test/                   合成数据与回归测试
```

新增其他来源或目标应作为独立适配器，不直接复用 Claude/dsh 的内部文件格式假设。dsh 升级后先检查其 Session 类型、持久化契约及格式迁移，再更新版本门控和原生读写测试；不要仅放宽版本号。

目标会话 ID 由固定的 `agent-sessions/<来源>/v1/<来源会话 ID>` 命名空间派生（见 `src/native.mjs`、`src/convert.mjs`），与该命名空间绑定的已发布会话视为同一身份。改这个字符串等于换 ID：已导入的会话会被当成新会话，请保持原样。

## 回归约束

- 默认仅主会话；默认只读预览，显式 `--write` 才导入。
- 保持已发布会话的 ID、正常输入的事件前缀和已有清单兼容，不自动整理旧会话。
- 来源语义不确定时拒绝转换。缺失结果恢复不能绕过工具 ID 冲突或压缩边界歧义。
- `ok` 表示完整流程成功；历史已发布但分组、置顶或应用验证失败时保留历史，返回部分成功及非零退出码。
- `--app` 只读验证列表和历史；CLI 通过独立原生注册表写分组/置顶，应用需要重启才能读取。

## 2026-10-30 审查修复

原实现先从 CLI 写注册表，再调用应用置顶；应用的旧文档会覆盖新分组。置顶改为读取最新磁盘状态的原生操作，测试用两个真实 Registry Context 覆盖这条交互路径。

已管理会话先读取原导入头，再决定是否需要 cwd 回退。新的显式 cwd 与原记录冲突时拒绝，默认目录变化不妨碍重复检测。分组错误同时进入 CLI 退出码和批量 `workspaceFailed` 统计，允许单独重试而不重写历史。

压缩清单必须是可验证 UUID 数组；已知且位于摘要前的本地命令、meta prompt、计时记录可以出现在清单中，但不成为模型输入。重复对话记录不能充当元数据豁免，未知或已退出活动上下文的对话 UUID 拒绝。未收到真实结果的工具调用 ID 不可重用，即使跨步骤或启用恢复模式；损坏 UTF-8 在解析前拒绝。

默认备份路径用文件 URL 解码得到，避免空格/中文目录被误当作 `%20` 等路径。重启提示仅针对本次实际登记工作区或改变置顶的情况。

复核命令为上述 `npm test`。本轮只读来源兼容性对照的摘要与排障材料保留在忽略的 `tmp/maintenance-20261030/`，不提交私有来源内容。当前只对 dsh 0.2.1-rc.2 / v4 验证，其他版本需重新适配。

## 后续计划

- [多来源导入](IMPORT_ADAPTERS_PLAN.md)：CodeBuddy 已实现，Codex 仍为规划。
- [dsh 插件入口](DSH_PLUGIN_PLAN.md)：尚未实现。
- [CodeBuddy 实施记录](CODEBUDDY_IMPLEMENTATION.md)：来源格式与首版验收范围。
