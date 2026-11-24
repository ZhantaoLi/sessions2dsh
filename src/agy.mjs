import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { isUtf8 } from 'node:buffer';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { sha256 } from './claude.mjs';
import { check, ToolError } from './errors.mjs';
import { buildNativeSession } from './native.mjs';
import { exists } from './runtime.mjs';

const knownTypes = new Set(['USER_INPUT', 'PLANNER_RESPONSE', 'GENERIC', 'SYSTEM_MESSAGE', 'CHECKPOINT', 'ERROR_MESSAGE']);
const mimeExt = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const trailingInjectedTags = ['ADDITIONAL_METADATA', 'USER_SETTINGS_CHANGE'];
const nonempty = value => typeof value === 'string' && value.length > 0;
const isHarnessReminder = text => /Reminder:\s*work efficiently\./.test(text) && !text.includes('[Message]');

function unwrapUserInput(raw) {
  let rest = raw.trimEnd();
  const stripped = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (const tag of trailingInjectedTags) {
      const close = `</${tag}>`;
      if (!rest.endsWith(close)) continue;
      const idx = rest.lastIndexOf(`\n<${tag}>`);
      if (idx < 0) continue;
      const cut = idx > 0 && rest[idx - 1] === '\r' ? idx - 1 : idx;
      stripped.unshift(tag);
      rest = rest.slice(0, cut).trimEnd();
      changed = true;
      break;
    }
  }
  if (/^<USER_REQUEST>(?:\r?\n)?<\/USER_REQUEST>$/.test(rest)) {
    return { text: '', stripped: ['USER_REQUEST', ...stripped] };
  }
  const outer = /^<USER_REQUEST>\r?\n([\s\S]*)\r?\n<\/USER_REQUEST>$/.exec(rest);
  if (!outer) return { text: raw, stripped: [] };
  return { text: outer[1], stripped: ['USER_REQUEST', ...stripped] };
}

function fileUriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return null;
  // Antigravity/VS Code on Windows often percent-encodes drive colons (file:///c%3A/...).
  const normalized = uri.replace(/^file:\/\/\/([A-Za-z])%3[Aa]\//, 'file:///$1:/');
  try { return fileURLToPath(normalized); } catch { return null; }
}

function parseWorkspaceCwd(rawUris) {
  if (!nonempty(rawUris)) return undefined;
  let uris;
  try { uris = JSON.parse(rawUris); } catch { return undefined; }
  if (!Array.isArray(uris)) return undefined;
  for (const uri of uris) {
    const path = fileUriToPath(uri);
    if (path && isAbsolute(path)) return path;
  }
  return undefined;
}

function readSummariesMap(appDataDir) {
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(`SELECT conversation_id, title, step_count, workspace_uris, status,
      parent_conversation_id, nesting_depth, agent_name, not_fully_idle
      FROM conversation_summaries`).all();
    const map = new Map();
    for (const row of rows) map.set(row.conversation_id, row);
    return map;
  } catch (error) {
    if (error?.code === 'ERR_SQLITE_ERROR' && /unable to open database file/i.test(error.message)) return null;
    if (error?.code === 'ENOENT') return null;
    return null;
  } finally {
    try { db?.close(); } catch { /* Ignore close errors. */ }
  }
}

function readSummary(appDataDir, conversationId) {
  const dbPath = join(appDataDir, 'conversation_summaries.db');
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(`SELECT conversation_id, title, step_count, workspace_uris, status,
      parent_conversation_id, nesting_depth, agent_name, not_fully_idle
      FROM conversation_summaries WHERE conversation_id = ?`).get(conversationId) || null;
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* Ignore close errors. */ }
  }
}

async function resolveTranscriptPath(path) {
  const resolved = resolve(path);
  let target = resolved;
  try {
    if ((await stat(resolved)).isDirectory()) {
      target = join(resolved, '.system_generated', 'logs', 'transcript_full.jsonl');
    }
  } catch { /* Let realpath report ENOENT. */ }
  const source = await realpath(target);
  const parts = source.split(/[/\\]/).filter(Boolean);
  check(
    parts.length >= 5 &&
    parts.at(-1) === 'transcript_full.jsonl' &&
    parts.at(-2) === 'logs' &&
    parts.at(-3) === '.system_generated' &&
    parts.at(-5) === 'brain' &&
    nonempty(parts.at(-4)),
    'SOURCE_ID',
    'Antigravity 来源路径必须位于 brain/<conversation-id>/.system_generated/logs/transcript_full.jsonl。',
  );
  const sourceSessionId = parts.at(-4);
  const brainDir = dirname(dirname(dirname(source)));
  const appDataDir = dirname(dirname(brainDir));
  return { source, sourceSessionId, brainDir, appDataDir };
}

async function resolveMediaFile(media, brainDir, line, bestEffort) {
  check(media && typeof media === 'object', 'ATTACHMENT_UNSUPPORTED', `第 ${line} 行媒体条目格式无效。`);
  const mediaType = media.mime_type;
  const ext = mimeExt[mediaType];
  check(ext, 'ATTACHMENT_UNSUPPORTED', `第 ${line} 行不支持的媒体类型：${mediaType || 'unknown'}。`);
  check(typeof media.uri === 'string' && media.uri.length > 0, 'EXTERNAL_RESULT', `第 ${line} 行媒体 URI 缺失。`);
  let reference = null;
  if (media.uri.startsWith('file://')) {
    reference = fileUriToPath(media.uri);
  } else if (!/^[a-zA-Z][a-zA-Z0-9+.-]{1,}:/.test(media.uri) && isAbsolute(media.uri)) {
    reference = resolve(media.uri);
  }
  check(reference && isAbsolute(reference), 'EXTERNAL_RESULT', `第 ${line} 行媒体 URI 不是本地绝对路径或 file:// 路径。`);
  const prefix = brainDir.endsWith(sep) ? brainDir : brainDir + sep;
  let real, bytes;
  try {
    real = await realpath(reference);
  } catch (error) {
    if (bestEffort && error?.code === 'ENOENT') return { unreadable: error };
    throw new ToolError('EXTERNAL_RESULT', `第 ${line} 行媒体附件缺失或不可访问：${reference}`);
  }
  // Path containment is a security boundary and is never bypassed by --best-effort.
  const within = process.platform === 'win32'
    ? real.toLowerCase().startsWith(prefix.toLowerCase())
    : real.startsWith(prefix);
  check(within, 'EXTERNAL_RESULT', `第 ${line} 行媒体附件路径越出当前会话目录：${reference}`);
  try {
    bytes = await readFile(real);
  } catch (error) {
    if (bestEffort) return { unreadable: error };
    throw new ToolError('EXTERNAL_RESULT', `第 ${line} 行媒体附件不可读：${reference}`);
  }
  return { file: { source: real, reference, bytes, sha256: sha256(bytes), backup: `external/${sha256(reference)}.${ext}`, mediaType, uri: media.uri } };
}

export async function readAgy(path, options = {}) {
  const { source, sourceSessionId, brainDir, appDataDir } = await resolveTranscriptPath(path);
  const summary = readSummary(appDataDir, sourceSessionId);
  const isRunning = summary?.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(summary?.not_fully_idle);
  if (!options._listMode) {
    check(!isRunning || options.bestEffort, 'ACTIVE_SESSION',
      'Antigravity 会话仍在运行中（CASCADE_RUN_STATUS_RUNNING）；请等待结束后再导入，或显式使用 --best-effort。');
  }
  const bytes = await readFile(source);
  check(isUtf8(bytes), 'INVALID_ENCODING', '来源 JSONL 不是有效 UTF-8；请检查文件是否损坏。');
  const records = [];
  let lastStep;
  for (const [index, line] of bytes.toString('utf8').split('\n').entries()) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { throw new ToolError('INVALID_JSONL', `第 ${index + 1} 行不是完整 JSON；请等待源会话写入结束。`); }
    check(row && typeof row === 'object' && !Array.isArray(row), 'INVALID_JSONL', `第 ${index + 1} 行不是记录对象。`);
    check(knownTypes.has(row.type), 'RECORD_UNSUPPORTED', `第 ${index + 1} 行未知 Antigravity 记录类型：${row.type}。`);
    check(Number.isSafeInteger(row.step_index) && row.step_index >= 0, 'INVALID_JSONL', `第 ${index + 1} 行缺少有效的 step_index。`);
    check(lastStep === undefined || row.step_index > lastStep, 'BRANCH_UNSUPPORTED', `第 ${index + 1} 行 step_index 非严格递增，无法确认单链历史。`);
    check(Number.isSafeInteger(Date.parse(row.created_at)) && Date.parse(row.created_at) >= 0, 'TIMESTAMP', `第 ${index + 1} 行时间戳无效。`);
    if (!options._listMode) {
      check(row.type !== 'CHECKPOINT' || options.bestEffort, 'COMPACTION_UNSUPPORTED',
        `第 ${index + 1} 行包含压缩检查点（CHECKPOINT），无法确认历史淘汰边界。确认可接受后加 --best-effort。`);
    }
    lastStep = row.step_index;
    records.push({ ...row, sourceLine: index + 1 });
  }
  check(records.length, 'EMPTY_SOURCE', '源会话为空。');
  const files = [];
  const mediaErrors = new Map();
  if (!options._listMode) {
    for (const row of records) {
      if (!Array.isArray(row.media) || !row.media.length) continue;
      for (const media of row.media) {
        const resolved = await resolveMediaFile(media, brainDir, row.sourceLine, options.bestEffort === true);
        if (resolved.unreadable) {
          mediaErrors.set(media.uri, resolved.unreadable.code || resolved.unreadable.message);
        } else if (!files.some(f => f.source === resolved.file.source)) {
          files.push(resolved.file);
        }
      }
    }
  }
  const cwd = parseWorkspaceCwd(summary?.workspace_uris);
  const isSubagent = Boolean(summary?.parent_conversation_id) || Number(summary?.nesting_depth) > 0;
  return {
    source, bytes, sourceSha256: sha256(bytes), sourceSessionId, sourceKind: 'agy',
    brainDir, cwd, summaryTitle: summary?.title || '', isSubagent,
    parentConversationId: summary?.parent_conversation_id || '', isRunning,
    records, files, mediaErrors,
  };
}

export async function prepareAgy(input, options = {}) {
  const items = [], skipped = [], warnings = [], conversions = [];
  const bestEffort = options.bestEffort === true;
  const pendingTools = [];
  let hasUserTurn = false;
  let missingModelSteps = 0;
  const fileByUri = new Map((input.files || []).map(f => [f.uri, f]));
  if (input.isRunning) {
    warnings.push('源会话在数据库标记为运行中（CASCADE_RUN_STATUS_RUNNING）；按 --best-effort 以当前快照继续导入。');
  }
  const appendMediaBlocks = (row, blocks) => {
    if (!Array.isArray(row.media) || !row.media.length) return;
    for (const media of row.media) {
      if (input.mediaErrors?.has(media.uri)) {
        const reason = input.mediaErrors.get(media.uri);
        conversions.push({ line: row.sourceLine, type: 'media unreadable → omitted under best-effort', uri: media.uri });
        warnings.push(`第 ${row.sourceLine} 行媒体附件不可读（${reason}）；按 --best-effort 跳过该图片并保留其余内容。`);
        continue;
      }
      const file = fileByUri.get(media.uri);
      const prepared = file && options.attachments?.get(`file:${file.reference}`);
      check(prepared, 'ATTACHMENT_UNSUPPORTED', `第 ${row.sourceLine} 行媒体图片尚未经过原生附件校验。`);
      conversions.push({ line: row.sourceLine, type: 'local media image → native immutable attachment', attachmentId: prepared.ref.attachmentId });
      blocks.push({ type: 'image', attachment: prepared.ref });
    }
  };

  for (const row of input.records) {
    const line = row.sourceLine;
    const time = Date.parse(row.created_at);
    const stepId = `step-${row.step_index}`;
    if (row.type === 'USER_INPUT') {
      check(typeof row.content === 'string', 'CONTENT', `第 ${line} 行用户输入缺少文本内容。`);
      pendingTools.length = 0;
      const unwrapped = unwrapUserInput(row.content);
      if (unwrapped.stripped.length) {
        conversions.push({ line, type: `Antigravity injected wrapper (${unwrapped.stripped.join(', ')}) → unwrapped user text` });
      }
      const content = [];
      if (unwrapped.text.length || !row.media?.length) content.push({ type: 'text', text: unwrapped.text });
      appendMediaBlocks(row, content);
      items.push({ kind: 'user', content, time, ids: [stepId], lines: [line] });
      hasUserTurn = true;
      continue;
    }
    if (row.type === 'PLANNER_RESPONSE') {
      const model = nonempty(row.model) ? row.model : 'unknown';
      if (!nonempty(row.model)) missingModelSteps++;
      pendingTools.length = 0;
      const content = [];
      if (nonempty(row.thinking)) content.push({ type: 'reasoning', text: row.thinking });
      if (nonempty(row.content)) content.push({ type: 'text', text: row.content });
      if (Array.isArray(row.tool_calls)) {
        for (const [index, call] of row.tool_calls.entries()) {
          check(call && typeof call === 'object' && nonempty(call.name), 'TOOL_ARGUMENTS', `第 ${line} 行工具调用缺少名称。`);
          check(call.args === undefined || (call.args && typeof call.args === 'object' && !Array.isArray(call.args)),
            'TOOL_ARGUMENTS', `第 ${line} 行工具参数不是 JSON 对象。`);
          const callId = `agy-s${row.step_index}-c${index}`;
          content.push({ type: 'tool-call', id: callId, name: call.name, arguments: JSON.stringify(call.args ?? {}) });
          pendingTools.push({ callId, name: call.name });
        }
      }
      if (!content.length) {
        skipped.push({ line, type: row.type, reason: '空助手响应（可能被安全过滤或中断），仅保留在来源备份中' });
        warnings.push(`第 ${line} 行空助手响应未作为模型回复导入，原文保留在来源备份中。`);
        continue;
      }
      const completed = row.status === 'DONE' && pendingTools.length === 0;
      items.push({ kind: 'assistant', content, model, time, ids: [stepId], lines: [line], blockTimes: content.map(() => time), completed });
      continue;
    }
    if (row.type === 'GENERIC') {
      check(pendingTools.length > 0, 'ORPHAN_RESULT', `第 ${line} 行工具结果没有对应的待完成调用。`);
      const call = pendingTools.shift();
      let text = typeof row.content === 'string' ? row.content : '';
      if (nonempty(row.error) && !text.includes(row.error)) text = text ? `${text}\nError: ${row.error}` : row.error;
      const content = [];
      if (text.length || !row.media?.length) content.push({ type: 'text', text });
      appendMediaBlocks(row, content);
      if (!content.length) content.push({ type: 'text', text: '' });
      const isError = row.status === 'ERROR' || nonempty(row.error);
      items.push({ kind: 'result', callId: call.callId, name: call.name, content, isError, time, ids: [stepId], lines: [line] });
      continue;
    }
    if (row.type === 'SYSTEM_MESSAGE') {
      check(typeof row.content === 'string', 'CONTENT', `第 ${line} 行系统消息缺少文本内容。`);
      if (isHarnessReminder(row.content)) {
        skipped.push({ line, type: row.type, reason: 'Antigravity 运行提醒，仅保留在来源备份中' });
        continue;
      }
      if (!hasUserTurn) {
        if (input.isSubagent) {
          items.push({ kind: 'user', content: [{ type: 'text', text: row.content }], time, ids: [stepId], lines: [line] });
          conversions.push({ line, type: 'Antigravity subagent initial SYSTEM_MESSAGE → initial user task turn' });
          hasUserTurn = true;
          continue;
        }
        skipped.push({ line, type: row.type, reason: '首个用户轮次之前的系统消息，仅保留在来源备份中' });
        continue;
      }
      check(pendingTools.length === 0, 'UNFINISHED_TOOL', `第 ${line} 行系统消息出现在工具调用结果收齐之前。`);
      items.push({ kind: 'context', content: [{ type: 'text', text: row.content }], time, ids: [stepId], lines: [line] });
      conversions.push({ line, type: 'Antigravity async system message → context in current turn' });
      continue;
    }
    if (row.type === 'ERROR_MESSAGE') {
      const detail = (nonempty(row.error) ? row.error : nonempty(row.content) ? row.content : '未知系统错误').replace(/\s+/g, ' ').slice(0, 120);
      skipped.push({ line, type: row.type, reason: 'Antigravity 系统错误/API 重试记录，仅保留在来源备份中' });
      warnings.push(`第 ${line} 行系统错误记录未作为模型回复导入：${detail}`);
      continue;
    }
    if (row.type === 'CHECKPOINT') {
      check(bestEffort, 'COMPACTION_UNSUPPORTED', `第 ${line} 行包含压缩检查点（CHECKPOINT），无法确认历史淘汰边界。确认可接受后加 --best-effort。`);
      const text = typeof row.content === 'string' ? row.content : '';
      conversions.push({ line, type: 'Antigravity checkpoint → kept in conversation, earlier history retained' });
      warnings.push(`第 ${line} 行包含压缩检查点（CHECKPOINT）；按 --best-effort 保留摘要正文并保留压缩前历史。`);
      items.push({ kind: hasUserTurn ? 'context' : 'user', content: [{ type: 'text', text }], time, ids: [stepId], lines: [line] });
      hasUserTurn = true;
    }
  }
  if (missingModelSteps > 0) {
    warnings.push(`源日志中有 ${missingModelSteps} 条助手响应未记录原模型名，已记为 unknown，未从当前配置猜测。`);
  }
  const cwd = options.cwd || input.cwd;
  const firstText = items.find(i => i.kind === 'user')?.content.filter(b => b.type === 'text').map(b => b.text).join(' ') || input.sourceSessionId;
  const prefix = input.isSubagent ? '[Antigravity 子代理]' : '[Antigravity]';
  const title = `${prefix} ${input.summaryTitle || firstText}`;
  return { items, cwd, title, skipped, warnings, conversions };
}

export async function convertAgy(input, runtime, options) {
  return buildNativeSession(input, runtime, await prepareAgy(input, options), options);
}

export async function listAgy(root, options = {}) {
  const brainRoot = join(root, 'brain');
  let entries;
  try { entries = await readdir(brainRoot, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const summaries = readSummariesMap(root) || new Map();
  const sessions = [];
  for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const id = entry.name;
    const summary = summaries.get(id);
    const isSubagent = Boolean(summary?.parent_conversation_id) || Number(summary?.nesting_depth) > 0;
    if (isSubagent && !options.includeSubagents) continue;
    const transcriptPath = join(brainRoot, id, '.system_generated', 'logs', 'transcript_full.jsonl');
    const cwd = parseWorkspaceCwd(summary?.workspace_uris) || '';
    const running = summary?.status === 'CASCADE_RUN_STATUS_RUNNING' || Boolean(summary?.not_fully_idle);
    if (!(await exists(transcriptPath))) {
      if (summary && summary.step_count === 0) {
        sessions.push({ id, kind: 'empty', sourceKind: 'agy', cwd, title: summary.title || id, source: transcriptPath, skipReason: '空会话，尚未产生对话记录' });
      } else {
        sessions.push({ id, kind: isSubagent ? 'subagent' : 'main', sourceKind: 'agy', cwd, title: summary?.title || id, source: transcriptPath, error: '缺少 transcript_full.jsonl', code: 'EMPTY_SOURCE' });
      }
      continue;
    }
    try {
      const input = await readAgy(transcriptPath, { _listMode: true });
      const info = await stat(transcriptPath);
      const firstUser = input.records.find(r => r.type === 'USER_INPUT' && nonempty(r.content));
      const fallbackTitle = firstUser ? unwrapUserInput(firstUser.content).text : '';
      sessions.push({
        id, kind: isSubagent ? 'subagent' : 'main', sourceKind: 'agy',
        ...(summary?.parent_conversation_id ? { parentConversationId: summary.parent_conversation_id } : {}),
        cwd, title: (summary?.title || fallbackTitle || id).replace(/\s+/g, ' ').slice(0, 100),
        source: input.source, bytes: info.size, updatedAt: info.mtime.toISOString(), rows: input.records.length,
        ...(running ? { running: true } : {}),
      });
    } catch (error) {
      sessions.push({ id, sourceKind: 'agy', cwd, source: transcriptPath, ...(error.code === 'EMPTY_SOURCE' ? { skipReason: error.message, kind: 'empty' } : { error: error.message, code: error.code }) });
    }
  }
  return sessions.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
}
