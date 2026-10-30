import { readFile, readdir, stat, realpath } from 'node:fs/promises';
import { resolve, join, basename, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { check, ToolError } from './errors.mjs';

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function readSource(path) {
  const source = await realpath(resolve(path));
  const bytes = await readFile(source);
  const records = [];
  for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new ToolError('INVALID_JSONL', `第 ${index + 1} 行不是完整 JSON；请等待源会话写入结束。`); }
    check(row && typeof row === 'object' && !Array.isArray(row), 'INVALID_JSONL', `第 ${index + 1} 行不是记录对象。`);
    records.push({ ...row, sourceLine: index + 1 });
  }
  check(records.length, 'EMPTY_SOURCE', '源会话为空。');
  const ids = new Set(records.map(row => row.sessionId).filter(Boolean));
  check(ids.size === 1, 'SOURCE_ID', '源文件必须包含唯一的 Claude sessionId。');
  const agentIds = new Set(records.map(row => row.agentId).filter(Boolean));
  const agentFile = /\/subagents\/(?:.*\/)?agent-([^/]+)\.jsonl$/.exec(source);
  const agentId = agentFile && agentIds.size === 1 && agentIds.has(agentFile[1]) ? agentFile[1] : undefined;
  return { source, bytes, sourceSha256: sha256(bytes), sourceSessionId: [...ids][0], agentId, records };
}

export function contentOf(row) {
  const content = row.message?.content;
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  check(Array.isArray(content) && content.every(b => b && typeof b === 'object'), 'CONTENT', `第 ${row.sourceLine} 行缺少有效消息内容。`);
  return content;
}

export function prepareRows(input, options = {}) {
  const rows = [], skipped = [], warnings = [];
  const seen = new Map(), assistantIds = new Set(), humanChildren = new Map(), assistantChildren = new Map();
  const skip = (row, reason) => skipped.push({ line: row.sourceLine, type: row.type, reason });
  for (const row of input.records) {
    if (row.type === 'system' && row.subtype === 'compact_boundary') {
      const summary = input.records.find(r => r.parentUuid === row.uuid && r.isCompactSummary);
      check(summary && row.compactMetadata?.preservedMessages, 'COMPACTION_UNSUPPORTED', `第 ${row.sourceLine} 行缺少可验证的压缩摘要或保留消息清单。`);
      skip(row, '压缩边界，由紧随的摘要映射为原生 surface replacement'); continue;
    }
    if (!['user', 'assistant'].includes(row.type)) { skip(row, '运行元数据，仅保留在来源备份中'); continue; }
    check(!row.isSidechain || input.agentId, 'BRANCH_UNSUPPORTED', `第 ${row.sourceLine} 行是未独立标识的子会话/旁支。`);
    if (row.uuid && seen.has(row.uuid)) {
      const { sourceLine, ...value } = row;
      check(seen.get(row.uuid) === JSON.stringify(value), 'DUPLICATE_UUID', `第 ${row.sourceLine} 行重复 UUID 的内容不同。`);
      skip(row, '重复的相同 UUID 记录'); continue;
    }
    if (row.uuid) { const { sourceLine, ...value } = row; seen.set(row.uuid, JSON.stringify(value)); }
    const content = contentOf(row);
    if (!rows.length && row.type === 'assistant' && content.every(b => b.type === 'text' && b.text === 'No response requested.')) {
      skip(row, '本地命令的 No response requested 响应'); continue;
    }
    if (row.type === 'user' && (row.isMeta || content.some(b => b.type === 'text' && /^\s*<(command-name|local-command-stdout|local-command-caveat)>/.test(b.text)))) {
      skip(row, 'Claude 本地命令或 meta prompt'); continue;
    }
    check(Number.isSafeInteger(Date.parse(row.timestamp)) && Date.parse(row.timestamp) >= 0, 'TIMESTAMP', `第 ${row.sourceLine} 行时间戳无效。`);
    if (row.type === 'assistant' && row.parentUuid) {
      const previous = assistantChildren.get(row.parentUuid);
      check(!previous || (row.message.id && previous.id === row.message.id), 'BRANCH_UNSUPPORTED',
        `第 ${row.sourceLine} 行与第 ${previous?.line} 行构成助手消息分支。`);
      assistantChildren.set(row.parentUuid, { id: row.message.id, line: row.sourceLine });
    }
    if (row.type === 'user' && !content.some(b => b.type === 'tool_result') && row.parentUuid) {
      const previous = humanChildren.get(row.parentUuid);
      check(!previous || !rows.some(r => r.type === 'assistant' && r.sourceLine > previous), 'BRANCH_UNSUPPORTED', `第 ${row.sourceLine} 行与第 ${previous} 行构成已有回答的用户消息分支。`);
      if (previous) warnings.push(`第 ${previous} 行用户消息在回复前被第 ${row.sourceLine} 行替换；旧消息保留在 transcript，退出活动上下文。`);
      humanChildren.set(row.parentUuid, row.sourceLine);
    }
    const last = rows.at(-1);
    if (row.type === 'assistant' && row.message.id && last?.type === 'assistant' && last.message.id === row.message.id) {
      last.message.content.push(...content); last.sourceLines.push(row.sourceLine);
      last.sourceUuids.push(row.uuid || `line-${row.sourceLine}`); last.blockTimes.push(...content.map(() => Date.parse(row.timestamp)));
      last.timestamp = row.timestamp; last.message.stop_reason = row.message.stop_reason ?? last.message.stop_reason;
    } else {
      if (row.type === 'assistant' && row.message.id) {
        // Some OpenAI-compatible providers reuse a completion ID across calls.
        // Tool results separate native steps even when the provider ID repeats.
        check(!assistantIds.has(row.message.id) || last?.type === 'user', 'BRANCH_UNSUPPORTED', `第 ${row.sourceLine} 行助手 message ID 非连续复现，无法安全合并。`);
        assistantIds.add(row.message.id);
      }
      rows.push({ ...row, message: { ...row.message, content: structuredClone(content) }, sourceLines: [row.sourceLine],
        sourceUuids: [row.uuid || `line-${row.sourceLine}`], blockTimes: content.map(() => Date.parse(row.timestamp)),
        ...(row.isCompactSummary ? { compaction: input.records.find(r => r.uuid === row.parentUuid)?.compactMetadata } : {}) });
    }
  }
  check(rows.length && rows[0].type === 'user', 'NO_USER_MESSAGE', '没有可导入的用户对话，或历史不是从用户消息开始。');
  const cwd = options.cwd || rows.find(row => row.cwd)?.cwd;
  check(cwd && isAbsolute(cwd), 'SOURCE_CWD', '源会话没有绝对工作目录；请用 --cwd 明确指定。');
  return { rows, skipped, warnings, cwd };
}

export async function listClaude(root, options = {}) {
  const sessions = [];
  let projects;
  try { projects = await readdir(root, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  for (const project of projects.filter(entry => entry.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const files = [];
    async function walk(directory, nested = false) {
      for (const file of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, file.name);
        if (file.isFile() && file.name.endsWith('.jsonl') && (!nested || /^agent-.+\.jsonl$/.test(file.name))) files.push(path);
        if (file.isDirectory() && options.includeSubagents) await walk(path, true);
      }
    }
    await walk(join(root, project.name));
    for (const path of files) {
      try {
        const input = await readSource(path);
        const users = input.records.filter(r => r.type === 'user' && !r.isMeta);
        const first = users.map(r => { try { return contentOf(r).filter(b => b.type === 'text').map(b => b.text).join('\n'); } catch { return ''; } })
          .find(text => text.trim() && !text.trimStart().startsWith('<')) || '';
        const info = await stat(path);
        sessions.push({ id: input.sourceSessionId, agentId: input.agentId, kind: input.agentId ? 'subagent' : 'main', project: project.name, cwd: users.find(r => r.cwd)?.cwd || '',
          title: first.replace(/\s+/g, ' ').slice(0, 100) || basename(path, '.jsonl'), source: path,
          bytes: info.size, updatedAt: info.mtime.toISOString(), rows: input.records.length });
      } catch (error) { sessions.push({ source: path, project: project.name, error: error.message }); }
    }
  }
  return sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
