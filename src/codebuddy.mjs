import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { resolve, join, basename, isAbsolute, sep, dirname } from 'node:path';
import { sha256 } from './claude.mjs';
import { check, ToolError } from './errors.mjs';
import { buildNativeSession } from './native.mjs';

const semantic = new Set(['message', 'reasoning', 'function_call', 'function_call_result']);
const metadata = new Set(['session-meta', 'file-history-snapshot', 'model-usage', 'ai-title', 'custom-title', 'turn-metrics']);
const nonempty = value => typeof value === 'string' && value.length > 0;
const knownSummary = r => r.type === 'summary' && ['initial-user-message', 'periodic', 'pre-compact'].includes(r.providerData?.source) && typeof r.summary === 'string';
const compactEnvelope = r => r.type === 'message' && r.role === 'user' && Array.isArray(r.content) && r.content.some(b => /<cb_summary\b|<conversation_history_summary\b|data-role=["']compact-summary["']/i.test(b.text || ''));

export async function readCodeBuddy(path) {
  const source = await realpath(resolve(path)), bytes = await readFile(source), records = [];
  for (const [i, line] of bytes.toString('utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { throw new ToolError('INVALID_JSONL', `第 ${i + 1} 行不是完整 JSON；请等待源会话写入结束。`); }
    check(row && typeof row === 'object' && !Array.isArray(row), 'INVALID_JSONL', `第 ${i + 1} 行不是记录对象。`);
    records.push({ ...row, sourceLine: i + 1 });
  }
  check(records.length, 'EMPTY_SOURCE', '源会话为空。');
  const unknown = records.find(r => !semantic.has(r.type) && !metadata.has(r.type) && !knownSummary(r));
  check(!unknown, 'RECORD_UNSUPPORTED', `第 ${unknown?.sourceLine} 行未知 CodeBuddy 记录或摘要语义：${unknown?.type}。`);
  const compact = records.find(r => compactEnvelope(r) || r.providerData?.isCompacted || r.providerData?.isSummary || r.providerData?.isCompactInternal || r.providerData?.compactType !== undefined || r.providerData?.agent === 'compact');
  check(!compact, 'COMPACTION_UNSUPPORTED', `第 ${compact?.sourceLine} 行包含真实压缩边界或恢复信封，首版尚不能准确重建活动上下文。`);
  const retired = records.find(r => r.providerData?.truncated !== undefined || r.providerData?.discard !== undefined);
  check(!retired, 'CONTEXT_UNSUPPORTED', `第 ${retired?.sourceLine} 行含 truncated/discard 历史淘汰标记，尚不能重建其生效范围。`);
  const ids = new Set(records.filter(r => semantic.has(r.type)).map(r => r.sessionId));
  check(ids.size > 0, 'EMPTY_DIALOGUE', '来源只有元数据，没有对话。');
  check(ids.size === 1 && nonempty([...ids][0]), 'SOURCE_ID', '来源对话必须包含唯一 CodeBuddy sessionId（纯元数据或混合身份不导入）。');
  const sub = /\/subagents\/agent-([^/]+)\.jsonl$/.exec(source);
  const flags = new Set(records.filter(r => semantic.has(r.type)).map(r => r.providerData?.isSubAgent).filter(v => v !== undefined));
  check([...flags].every(v => typeof v === 'boolean'), 'SOURCE_ID', 'CodeBuddy 子代理标识不是布尔值。');
  check(!sub || !flags.has(false), 'SOURCE_ID', '子代理路径与显式主会话标识冲突。');
  check(!flags.has(true) || (sub && !flags.has(false)), 'SOURCE_ID', '来源包含无法独立识别或混合的子代理记录。');
  const agentId = sub?.[1], sourceSessionId = [...ids][0];
  for (const row of records.filter(r => r.type === 'session-meta')) {
    check(!row.sessionId || row.sessionId === sourceSessionId || (agentId && row.sessionId === `agent-${agentId}`), 'SOURCE_ID', 'session-meta 与来源会话身份不一致。');
  }
  return { source, bytes, sourceSha256: sha256(bytes), sourceSessionId, sourceKind: 'codebuddy', agentId, records, files: [] };
}

function textContent(content, types, line) {
  check(Array.isArray(content), 'CONTENT', `第 ${line} 行缺少内容数组。`);
  return content.map(b => {
    check(b && types.includes(b.type) && typeof b.text === 'string', 'BLOCK_UNSUPPORTED', `第 ${line} 行包含不支持的内容块。`);
    return { type: 'text', text: b.text };
  });
}

async function fullToolOutput(input, row, conversions) {
  const text = row.output.text;
  if (!text.trimStart().startsWith('<persisted-output>')) return text;
  const matches = [...text.matchAll(/Full output saved to: ([^\r\n]+)/g)];
  check(matches.length === 1 && text.trimEnd().endsWith('</persisted-output>'), 'EXTERNAL_RESULT', `第 ${row.sourceLine} 行外置结果标记不完整。`);
  const reference = matches[0][1], folder = input.source.slice(0, -'.jsonl'.length);
  check(isAbsolute(reference) && dirname(reference) === join(folder, 'tool-results'), 'EXTERNAL_RESULT', `第 ${row.sourceLine} 行外置结果不在来源会话的 tool-results 目录；不自动猜测路径映射。`);
  let source, bytes;
  try {
    const sessionRoot = await realpath(folder), allowed = join(sessionRoot, 'tool-results');
    check(await realpath(join(folder, 'tool-results')) === allowed, 'EXTERNAL_RESULT', 'tool-results 目录不能链接到来源会话外部。');
    source = await realpath(reference);
    check(source.startsWith(allowed + sep) && dirname(source) === allowed, 'EXTERNAL_RESULT', '外置结果不能通过符号链接离开来源会话。');
    bytes = await readFile(source);
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) { throw new ToolError('EXTERNAL_RESULT', `第 ${row.sourceLine} 行外置结果缺失、路径越界或不是 UTF-8 文本；未使用截断预览替代。`); }
  if (!input.files.some(f => f.source === source)) input.files.push({ source, reference, bytes, sha256: sha256(bytes), backup: `external/${sha256(reference)}.txt` });
  conversions.push({ line: row.sourceLine, type: 'external tool result → full text and source snapshot', source, sha256: sha256(bytes) });
  return bytes.toString('utf8');
}

export async function prepareCodeBuddy(input, options = {}) {
  const items = [], skipped = [], warnings = [], conversions = [], seen = new Map(), groupKeys = new Set();
  let lastRecord, group;
  const skip = (r, reason) => skipped.push({ line: r.sourceLine, type: r.type, reason });
  for (const row of input.records) {
    const p = row.providerData || {}, line = row.sourceLine;
    check(!p.isCompacted && !p.isSummary && !p.isCompactInternal && p.compactType === undefined && p.agent !== 'compact', 'COMPACTION_UNSUPPORTED', `第 ${line} 行包含真实压缩边界，首版尚不能准确重建活动上下文。`);
    if (row.type === 'summary') {
      check(['initial-user-message', 'periodic', 'pre-compact'].includes(p.source) && typeof row.summary === 'string', 'COMPACTION_UNSUPPORTED', `第 ${line} 行摘要类型未知。`);
      skip(row, 'CodeBuddy 列表摘要，不替换模型上下文'); continue;
    }
    if (metadata.has(row.type)) { skip(row, '运行元数据，仅保留原件'); continue; }
    check(semantic.has(row.type), 'RECORD_UNSUPPORTED', `第 ${line} 行未知 CodeBuddy 记录类型：${row.type}。`);
    check(nonempty(row.id), 'SOURCE_ID', `第 ${line} 行缺少消息 ID。`);
    const { sourceLine, ...value } = row, serialized = JSON.stringify(value);
    if (seen.has(row.id)) {
      check(seen.get(row.id) === serialized, 'DUPLICATE_ID', `第 ${line} 行重复 ID 的内容不同。`);
      skip(row, '相同 ID 的重复记录'); continue;
    }
    seen.set(row.id, serialized);
    check(Number.isSafeInteger(row.timestamp) && row.timestamp >= 0, 'TIMESTAMP', `第 ${line} 行时间戳不是非负毫秒整数。`);
    // Parent links follow stored history, not timestamps or mainAgent names.
    check(!lastRecord || row.parentId === lastRecord.id, 'BRANCH_UNSUPPORTED', `第 ${line} 行不是可证明的单链历史（分支、缺失父记录或重置边界）。`);
    check(lastRecord || !row.parentId, 'BRANCH_UNSUPPORTED', `第 ${line} 行继承了未提供的父历史。`);
    lastRecord = row;
    if (row.type === 'message' && row.role === 'user') {
      const content = textContent(row.content, ['input_text'], line);
      const local = content.some(b => /^\s*<(?:command-name|local-command-stdout|local-command-caveat)\b|^\s*<system-reminder\b[^>]*data-role="command-caveat"/.test(b.text));
      const context = p.isMeta && (p.skipRun !== true || ['todo', 'task'].includes(p.taskReminderKind) || Array.isArray(p.modRunFeedbackKeys));
      if (context) {
        check(p.startsNewUserRequest !== true, 'META_UNSUPPORTED', `第 ${line} 行注入消息同时声明新用户请求，无法确定轮次。`);
        items.push({ kind: 'context', content, time: row.timestamp, ids: [row.id], lines: [line] }); group = undefined;
        conversions.push({ line, type: 'CodeBuddy injected input → original user role in current turn' }); continue;
      }
      if (p.skipRun || local) { skip(row, '本地命令或不发给模型的附带内容'); continue; }
      items.push({ kind: 'user', content, time: row.timestamp, ids: [row.id], lines: [line] }); group = undefined; continue;
    }
    if (row.type === 'function_call_result') {
      check(nonempty(row.callId) && nonempty(row.name) && ['completed', 'incomplete'].includes(row.status), 'TOOL_CONTENT', `第 ${line} 行工具结果标识或状态无效。`);
      check(row.output?.type === 'text' && typeof row.output.text === 'string', 'TOOL_CONTENT', `第 ${line} 行工具结果不是已支持的文本。`);
      items.push({ kind: 'result', callId: row.callId, name: row.name, content: [{ type: 'text', text: await fullToolOutput(input, row, conversions) }], isError: row.status !== 'completed' || !!p.toolResult?.error, time: row.timestamp, ids: [row.id], lines: [line] });
      group = undefined; continue;
    }
    check(row.type !== 'message' || row.role === 'assistant', 'ROLE_UNSUPPORTED', `第 ${line} 行消息角色不支持。`);
    if (row.type === 'message' && p.skipRun === true && p.error && row.status === 'incomplete') {
      textContent(row.content, ['output_text'], line);
      skip(row, '本地错误提示，仅保留原件；不伪造模型响应');
      warnings.push(`第 ${line} 行本地错误提示未作为模型回复导入，原文在来源备份中。`); group = undefined; continue;
    }
    check(nonempty(p.model), 'MODEL_METADATA', `第 ${line} 行缺少原模型名称，拒绝猜测。`);
    const hasGroup = nonempty(p.messageId) && nonempty(p.conversationRequestId) && Number.isSafeInteger(p.stepSeq);
    const key = hasGroup ? JSON.stringify([p.conversationRequestId, p.messageId, p.stepSeq]) : row.id;
    if (!group || group.key !== key) {
      check(!groupKeys.has(key), 'BRANCH_UNSUPPORTED', `第 ${line} 行同一模型步骤非连续复现。`);
      groupKeys.add(key); group = { kind: 'assistant', key, content: [], model: p.model, time: row.timestamp, ids: [], lines: [], blockTimes: [], completed: false }; items.push(group);
    }
    check(group.model === p.model, 'MODEL_METADATA', `第 ${line} 行同一模型步骤的模型不一致。`);
    let blocks;
    if (row.type === 'reasoning') {
      const raw = row.rawContent !== undefined ? row.rawContent : row.content;
      blocks = textContent(raw, ['reasoning_text', 'input_text'], line).map(b => ({ type: 'reasoning', text: b.text }));
      if (row.rawContent !== undefined && row.content?.length) {
        textContent(row.content, ['input_text', 'reasoning_text'], line);
        check(row.content.map(b => b.text).join('') === raw.map(b => b.text).join(''), 'REASONING_UNSUPPORTED', `第 ${line} 行两份可读思考内容不一致。`);
      }
    } else if (row.type === 'function_call') {
      check(nonempty(row.callId) && nonempty(row.name) && typeof row.arguments === 'string', 'TOOL_ARGUMENTS', `第 ${line} 行工具调用无效。`);
      try { const args = JSON.parse(row.arguments); check(args && typeof args === 'object' && !Array.isArray(args), 'TOOL_ARGUMENTS', `第 ${line} 行工具参数不是 JSON 对象。`); }
      catch (error) { if (error instanceof ToolError) throw error; throw new ToolError('TOOL_ARGUMENTS', `第 ${line} 行工具参数不是完整 JSON。`); }
      blocks = [{ type: 'tool-call', id: row.callId, name: row.name, arguments: row.arguments }];
    } else {
      check(['completed', 'incomplete'].includes(row.status), 'MESSAGE_STATUS', `第 ${line} 行助手状态未知。`);
      blocks = textContent(row.content, ['output_text'], line); group.completed = row.status === 'completed';
    }
    group.content.push(...blocks); group.ids.push(row.id); group.lines.push(line); group.blockTimes.push(...blocks.map(() => row.timestamp)); group.time = row.timestamp;
  }
  const cwd = options.cwd || input.records.find(r => semantic.has(r.type) && r.cwd)?.cwd;
  const firstText = items.find(i => i.kind === 'user')?.content.map(b => b.text).join(' ') || input.sourceSessionId;
  const title = `[CodeBuddy${input.agentId ? ` 子代理 ${input.agentId.slice(0, 8)}` : ''}] ${firstText}`;
  return { items, cwd, title, skipped, warnings, conversions };
}

export async function convertCodeBuddy(input, runtime, options) {
  return buildNativeSession(input, runtime, await prepareCodeBuddy(input, options), options);
}

export async function listCodeBuddy(root, options = {}) {
  const sessions = [];
  async function walk(dir, project = '') {
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch (e) { if (e.code === 'ENOENT' && dir === root) return; throw e; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (dir === root || (options.includeSubagents && (e.name === 'subagents' || dir === join(root, project)))) await walk(path, project || e.name);
      } else if (e.isFile() && e.name.endsWith('.jsonl')) {
        try {
          const input = await readCodeBuddy(path), info = await stat(path);
          const first = input.records.find(r => r.type === 'message' && r.role === 'user' && !r.providerData?.skipRun && !r.providerData?.isMeta);
          const commandOnly = input.records.every(r => metadata.has(r.type) || knownSummary(r) || (r.type === 'message' && r.role === 'user' && r.providerData?.skipRun === true && !r.providerData?.isMeta));
          sessions.push({ id: input.sourceSessionId, agentId: input.agentId, kind: input.agentId ? 'subagent' : 'main', sourceKind: 'codebuddy', project,
            cwd: input.records.find(r => r.cwd)?.cwd || '', title: first?.content?.map(b => b.text || '').join(' ').replace(/\s+/g, ' ').slice(0, 100) || basename(path, '.jsonl'),
            source: path, bytes: info.size, updatedAt: info.mtime.toISOString(), rows: input.records.length,
            ...(commandOnly ? { skipReason: '只有本地命令，没有模型对话' } : {}) });
        } catch (e) {
          sessions.push({ source: path, project, ...(['EMPTY_SOURCE', 'EMPTY_DIALOGUE'].includes(e.code) ? { skipReason: e.message, kind: 'empty' } : { error: e.message, code: e.code }) });
        }
      }
    }
  }
  await walk(root); return sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
