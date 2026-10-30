# dsh 插件接入计划

状态：可行性调查与规划，尚未实现、安装或启用插件。
核对日期：2026-10-29；dsh 0.2.1-rc.2、Node v24.18.0。

## 已确认的扩展接口

证据来自当前安装的 `@deepseek-ai/dsh` 及其 `node_modules/@deepseek-ai/` 中的包，不把源码仓库相对链接当作本地可用文件：

| 能力 | 可用文档或接口 | 对本项目的意义 |
|---|---|---|
| 外部组合包 | dsh README.zh.md、dsh-plugin-manager/README.zh.md；组合包声明 `dsh.bundle.patch`，profile 选择 bundles | 可独立打包、本地安装，不必修改 dsh 内置代码 |
| 人工斜杠命令 | dsh-commands/README.zh.md、lib/types/index.d.ts；`ctx.commands.register()` | 在 Web 应用内直接列出、预览、导入；命令输入与结果不自动成为模型消息 |
| 原生存储 | dsh-session-persistence/lib/types/index.d.ts；`ctx.sessionPersistence.create/open/list` | 插件可使用宿主服务发布完整原生事件，无需模拟用户聊天 |
| 历史查询 | dsh-session-query/README.zh.md；`ctx.sessionQuery` | 导入后检查列表、历史与标题；界面即时刷新仍需集成验证 |
| 前端模块 | dsh-client-ui-sidebar/package.json；`dsh.client` 元数据及 `lib/client.js` | 支持附带浏览器模块，前端需要额外构建与宿主协议对接 |
| 全局页面 | dsh-client-ui-sidebar/README.zh.md；`sidebar.panellist` 与同 id 的 root `main` keyed slot | 可选增加“会话导入”导航及页面，不必另开独立网页 |

现有接口足以构建导入插件，但本轮没有发现可直接接收 Claude/Codex/CodeBuddy 日志的现成导入接口；来源解析、语义转换与完整校验仍由本工具负责。

## 推荐形态

保留轻量 CLI，增加一个外部插件包，两者调用同一核心：

```text
命令行入口 ─────────┐
dsh 人工斜杠命令 ───┼─> 来源适配器 / 转换 / 备份 / 幂等校验 ─> dsh 原生存储
可选导入页面 ───────┘
```

首版仅后端插件与人工命令，不注册模型工具、不增加前端构建。以下为拟定语法，尚不可执行：

```text
/session-import list --from claude
/session-import preview <来源路径>
/session-import import <来源路径> --write
/session-import batch --from claude --write
```

来源选择沿用多来源计划，Codex/CodeBuddy 适配器实现后再开放相应值。默认预检，实际发布显式 `--write`；默认排除子代理，可用 `--include-subagents` 纳入。长批次使用可查询任务状态和逐条报告，不能仅依赖一次命令响应承载完整结果。

第二阶段可增加页面：来源选择、会话列表、主/子筛选、预检说明、批量进度及导入结果。前端使用宿主 Remote 通道调用后端；后端仍负责路径、输入及写入校验。页面不是首版必需品。

## 现有代码需要调整的边界

- `manager` 已有内部 `_store` 注入，但 `planImport` 仍会 `loadRuntime`，`batch` 仍自行挂载存储；需要正式的目标环境接口，让 CLI 自行挂载、插件复用宿主 `ctx.sessionPersistence`。插件不得销毁宿主 Context。
- `runtime` 目前通过 PATH 查找全局 dsh，插件应从宿主兼容依赖取得 Session 校验器和相关类型，避免加载第二份运行时或挂载第二套后端。
- `attachments` 当前依赖本地实现及固定 `attachments/v1` 路径；插件需接入宿主附件服务。图片 prepare/commit/read 的具体宿主契约还需实现前核对，不能只替换目录。
- `app` 当前通过外部启动日志取得 Web 认证；插件内部改用宿主查询服务，不再读日志 token 调用自己。列表、标题、搜索及 UI 刷新需要分别验收。
- 备份目录从包内 `data/` 改为显式插件配置的持久目录；支持指定既有目录，并识别旧 CLI 清单。清单目标定位需覆盖宿主配置的存储，不能假定总是 `~/.dsh/sessions`。
- 保持 Claude 已发布 ID、事件前缀与清单兼容；插件接入不得生成重复会话或更改既有历史。来源适配器继续内置静态注册，无需另造来源插件市场。
- 取消与卸载遵循宿主生命周期：不开始下一条，完成当前写入的落盘与收尾，报告准确的部分成功状态；命令取消不能被误报为全部回滚。

## 打包、验证与实施顺序

1. 先以现有 Claude 路径完成宿主环境接口和最小人工命令，保留 CLI 回归。
2. 外部包提供 Cordis `apply`/`inject`、组合 patch 和 `dsh.bundle.patch` 元数据；明确 `engines.dsh` 及所需 peer 版本。首版只面向已验证的 0.2.1-rc.2，不用兼容性豁免绕过版本检查。
3. 在独立测试 Context 和隔离持久化根验证预检、单条导入、重复跳过、续聊前缀、附件、批量、默认排除子代理、取消和卸载。涉及 UI 的版本再验证浏览器模块加载与列表刷新。
4. 测试通过后再安排真实 web profile 的本地包安装和一个主会话验证。安装会改变该 profile 的组合，是否即时启用取决于 HMR；本轮没有检查其启用状态，也没有修改 profile 或重启应用。
5. 更多来源按 CodeBuddy 最小闭环、Codex 最小闭环推进；若需要图形操作，再附加前端页面。插件壳与新来源格式适配是不同工作项。

本轮结论的限制：已核对文档、类型与现成插件包结构，尚无自定义插件加载、宿主附件写入或前端构建实验。dsh 升级后需重新核对以上接口。
