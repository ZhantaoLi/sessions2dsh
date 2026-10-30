#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { listSessions, planImport, importSession, verifySession, doctor } from '../src/manager.mjs';
import { errorInfo, check } from '../src/errors.mjs';
import { batchImport } from '../src/batch.mjs';

const help = `sessions2dsh — 本地 agent 会话管理（Claude Code / CodeBuddy → dsh）

用法：
  node bin/sessions2dsh.mjs doctor
  node bin/sessions2dsh.mjs list [--from claude|codebuddy|dsh] [--project 关键词]
  node bin/sessions2dsh.mjs preview <会话.jsonl> [--from claude|codebuddy] [--messages]
  node bin/sessions2dsh.mjs import <会话.jsonl> [--from claude|codebuddy] [--write] [--app] [--pin]
  node bin/sessions2dsh.mjs verify <session-ID> [--app]
  node bin/sessions2dsh.mjs batch [--from claude|codebuddy] [--include-subagents] [--write] [--app]

选项：
  --write              实际新增原生 dsh 会话；省略时仅预览
  --title 文本         自定义导入标题
  --cwd /绝对目录      覆盖会话工作目录（默认保留来源目录）
  --workspace-sync      对自定义目标根启用 dsh 工作区登记
  --expect-sha SHA256   只导入预览时确认过的来源快照
  --expect-snapshot-sha SHA256  同时锁定 JSONL 与外置工具结果（CodeBuddy）
  --app                用运行中 dsh Web 的 API 检查列表与历史
  --pin                导入后在原生注册表置顶；应用重启后显示（隐含 --app）
  --messages           预览全部转换后的正文、思考与工具历史
  --include-subagents  list/batch 纳入子代理（默认仅主会话）
  --repair-interrupted 显式为来源缺失结果补“结果未知”的错误记录
  --report 路径        batch 每完成一个会话就原子更新 JSON 报告
  --reuse-receipt 路径  核对并登记旧工具的导入凭据，保留已续聊的会话
  --json               输出 JSON，便于脚本处理
  --claude-root 路径   Claude projects 目录
  --from 来源         claude（默认）或 codebuddy；list 另支持 dsh
  --source-root 路径   当前所选来源的 projects 目录
  --dsh-home 路径      dsh home（默认 $DSH_HOME 或 ~/.dsh）
  --target-root 路径   原生会话目录（默认 <dsh-home>/sessions）
  --data-dir 路径      来源备份与导入清单（默认 <工具目录>/data）
  --runtime 路径       已安装 @deepseek-ai/dsh 的目录（自动查找 PATH）
  --app-log 路径       dsh Web 启动日志（默认 <dsh-home>/web-launcher.log）
  -h, --help           帮助

当前只适配 dsh 0.2.1-rc.2 / v4。导入不会运行历史工具或自动发起模型请求。
`;

function display(result, json) {
  if (json) { console.log(JSON.stringify(result, null, 2)); return; }
  if (Array.isArray(result)) {
    if (!result.length) { console.log('没有找到会话。'); return; }
    for (const item of result) {
      console.log(`${item.error ? '[读取失败]' : item.title || item.id || '[空记录]'}\n  ${item.id || ''}  ${item.cwd || item.project || ''}\n  ${item.source || ''}${item.error ? `\n  ${item.error}` : ''}${item.skipReason ? `\n  [跳过] ${item.skipReason}` : ''}`);
    }
    console.log(`共 ${result.length} 个会话。`); return;
  }
  if ('node' in result) { console.log(JSON.stringify(result, null, 2)); return; }
  if (result.totals) {
    console.log(`${result.write ? '批量导入' : '批量预览'}：共 ${result.totals.candidates} 个；新增 ${result.totals.imported}，已存在 ${result.totals.existing}，预览 ${result.totals.preview}，跳过 ${result.totals.skipped || 0}，失败 ${result.totals.failed}，工作区登记失败 ${result.totals.workspaceFailed || 0}，应用验证失败 ${result.totals.applicationFailed}；工作流日志备份 ${result.totals.journals} 份。`);
    for (const item of result.results.filter(r => r.status === 'failed')) console.log(`${item.source}\n  [${item.code}] ${item.message}`);
    for (const item of result.results.filter(r => r.workspace?.ok === false)) console.error(`${item.source}\n  工作区登记失败：${item.workspace.error}；会话历史已保留，可重试。`);
    for (const warning of result.warnings || []) console.log(`提示：${warning}`);
    return;
  }
  const labels = { preview: '预览，尚未写入', imported: '导入成功', 'already-imported': '已导入，跳过重复写入', verified: '验证通过' };
  console.log(`${result.ok === false ? '会话历史已导入，部分步骤失败' : labels[result.status] || '预览，尚未写入'}\n标题：${result.title}\nID：${result.id}`);
  if (result.cwd) console.log(`cwd：${result.cwd}`);
  if (result.counts) console.log(`消息：用户 ${result.counts.users}，助手 ${result.counts.assistants}，工具 ${result.counts.toolCalls} 次，思考 ${result.counts.reasoning} 段`);
  if (result.targetRoot) console.log(`目标：${result.targetRoot}`);
  if (result.originalCwd && result.originalCwd !== result.cwd) console.log(`来源 cwd：${result.originalCwd}`);
  if (result.workspace?.ok === false) console.error(`工作区登记失败：${result.workspace.error}；会话历史已保留，可重试。`);
  else if (result.workspace) console.log(`工作区：${result.workspace.workspaceTitle || result.workspace.cwd}（${result.workspace.action}）`);
  if (result.pin?.ok === false) console.error(`置顶失败：${result.pin.message}；会话历史已保留。`);
  else if (result.pin?.pinned) console.log('置顶：已登记');
  if (result.sourceSha256) console.log(`来源 SHA256：${result.sourceSha256}`);
  if (result.snapshotSha256) console.log(`完整快照 SHA256：${result.snapshotSha256}`);
  if (result.duplicate) console.log('目标已包含相同历史前缀；重复导入会跳过，也允许已续聊的目标。');
  if (result.backup) console.log(`备份：${result.backup}`);
  if (result.status === 'verified') console.log(`历史前缀一致：${result.importedEvents}/${result.currentEvents} 条事件；源文件：${result.sourceState}`);
  for (const warning of result.warnings || []) console.log(`提示：${warning}`);
  for (const conversion of result.conversions || []) console.log(`转换：第 ${conversion.line} 行 ${conversion.type}`);
  if (result.limitations?.length) console.log(`边界：${result.limitations.join('；')}`);
  if (result.application) console.log(`应用：${JSON.stringify(result.application)}`);
  if (result.messages) console.log(JSON.stringify(result.messages, null, 2));
  if (result.hint) console.log(result.hint);
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    help: { type: 'boolean', short: 'h' }, json: { type: 'boolean' }, write: { type: 'boolean' },
    app: { type: 'boolean' }, pin: { type: 'boolean' }, messages: { type: 'boolean' },
    'include-subagents': { type: 'boolean' }, 'repair-interrupted': { type: 'boolean' },
    'workspace-sync': { type: 'boolean' },
    report: { type: 'string' }, 'reuse-receipt': { type: 'string' },
    title: { type: 'string' }, cwd: { type: 'string' }, from: { type: 'string' }, project: { type: 'string' },
    'expect-sha': { type: 'string' }, 'claude-root': { type: 'string' }, 'dsh-home': { type: 'string' },
    'expect-snapshot-sha': { type: 'string' },
    'source-root': { type: 'string' },
    'target-root': { type: 'string' }, 'data-dir': { type: 'string' }, runtime: { type: 'string' }, 'app-log': { type: 'string' },
  } });
  const [command, argument, ...extra] = positionals;
  if (values.help || !command || command === 'help') { console.log(help); }
  else {
    check(!extra.length, 'USAGE', '参数过多。执行 --help 查看用法。');
    check(['doctor', 'list', 'preview', 'import', 'verify', 'batch'].includes(command), 'USAGE', `未知命令 ${command}。执行 --help 查看用法。`);
    check(['preview', 'import', 'verify'].includes(command) ? !!argument : !argument, 'USAGE', '此命令的会话路径/ID 参数不正确。');
    check(!values.write || ['import', 'batch'].includes(command), 'USAGE', '--write 只能用于 import/batch。');
    check(!values.pin || (command === 'import' && values.write), 'USAGE', '--pin 只能用于 import --write。');
    const options = Object.fromEntries(Object.entries(values).map(([key, value]) => [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
    let result;
    if (command === 'doctor') result = await doctor(options);
    if (command === 'list') {
      result = await listSessions(options);
      if (options.project) result = result.filter(item => [item.project, item.cwd, item.title, item.id].some(value => value?.toLowerCase().includes(options.project.toLowerCase())));
    }
    if (command === 'preview') result = { status: 'preview', ...(await planImport(argument, options)).summary, hint: '未写入任何文件。使用 import <路径> --write 导入。' };
    if (command === 'import') result = await importSession(argument, options);
    if (command === 'verify') result = await verifySession(argument, options);
    if (command === 'batch') {
      check(!values.title && !values['expect-sha'] && !values['expect-snapshot-sha'] && !values.messages, 'USAGE', 'batch 不接受单会话的 --title、--expect-sha、--expect-snapshot-sha 或 --messages。');
      result = await batchImport({ ...options, onProgress: item => {
        if (!values.json) console.error(`[${item.completed}/${item.total}] ${item.status} ${item.id || item.error || ''}`);
      } });
    }
    display(result, values.json);
    if (result.ok === false || result.application?.ok === false) process.exitCode = 1;
  }
} catch (error) {
  const info = errorInfo(error);
  if (process.argv.includes('--json')) console.error(JSON.stringify({ ok: false, ...info }));
  else console.error(`错误 [${info.code}]：${info.message}`);
  process.exitCode = 1;
}
