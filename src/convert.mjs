import { isAbsolute } from 'node:path';
import { prepareRows, sha256 } from './claude.mjs';
import { check } from './errors.mjs';

export function stableUuid(value) {
  const h = sha256(value);
  return `${h.slice(0,8)}-${h.slice(8,12)}-8${h.slice(13,16)}-${((parseInt(h[16],16)&3)|8).toString(16)}${h.slice(17,20)}-${h.slice(20,32)}`;
}
export function targetSessionId(input) {
  // This namespace is part of published session identities, not the project name.
  const identity = `agent-sessions/${input.sourceKind || 'claude'}/v1/${input.sourceSessionId}${input.agentId ? `/agent/${input.agentId}` : ''}`;
  return `session-${stableUuid(identity)}`;
}
function normalizedTitle(value) {
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  let result = '';
  for (const char of cleaned) { if (Buffer.byteLength(result + char) > 120) break; result += char; }
  check(result, 'TITLE', '标题不能为空。'); return result;
}

export function convertClaude(input, runtime, options = {}) {
  const { rows, skipped, warnings, cwd, metadataUuids } = prepareRows(input, options);
  check(isAbsolute(cwd), 'SOURCE_CWD', '工作目录必须是绝对路径。');
  const identity = input.sourceSessionId + (input.agentId ? `/agent/${input.agentId}` : '');
  const id = targetSessionId(input);
  const firstText = rows[0].message.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
  const title = normalizedTitle(options.title || `${input.agentId ? `[Claude 子代理 ${input.agentId.slice(0, 8)}]` : '[Claude]'} ${firstText || input.sourceSessionId}`);
  const header = { version: 4, id, createdAt: Date.parse(rows[0].timestamp), cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  const session = runtime.Session.create(id, [], header);
  // Native construction adds seq 0 (session/end-seed), required by persistence.
  const events = session.snapshotEvents().map(event => ({ ...event, time: header.createdAt }));
  const mapping = [], conversions = [], pending = new Map(), callIds = new Set(), activeCalls = new Map();
  // Recovery closes a native step, but does not prove a source call completed.
  const unresolvedCalls = new Set();
  let turn = 0, step = 0, openTurn = false, openStep = false, time = header.createdAt, lastStop;
  const add = (type, data, surface = false) => {
    const event = { ...session.append(type, data, ...(surface ? [surface === true ? { surfaceOp: 'append' } : surface] : [])), time };
    events.push(event); return event;
  };
  const closeStep = () => {
    if (!openStep) return;
    if (pending.size && options.repairInterrupted) {
      for (const callId of pending.keys()) {
        const message = { ...runtime.createToolResultMessage({ callId, isError: true, content: [{ type: 'text', text: '[Claude import recovery] No tool result was recorded in the source. The outcome is unknown. Verify external state before retrying any operation with side effects.' }] }), id: stableUuid(`${identity}/recovery/${callId}`) };
        add('tool/result', { turn, step, message }, true);
        conversions.push({ type: 'missing tool result → explicit unknown-outcome error', callId });
      }
      pending.clear();
    }
    check(!pending.size, 'UNFINISHED_TOOL', `工具调用未收齐结果：${[...pending.keys()].join(', ')}；拒绝伪造工具结果。`);
    add('step/end', { turn, step }); openStep = false;
  };
  const closeTurn = () => {
    if (!openTurn) return;
    closeStep();
    const kind = !step || !lastStop ? 'interrupted' : lastStop === 'max_tokens' ? 'max-tokens' : 'completed';
    if (kind === 'interrupted') warnings.push(`第 ${turn} 轮没有明确完成标记，按 interrupted 保留。`);
    add('turn/end', { turn, reason: { kind } }); openTurn = false;
  };
  const record = (row, event, extra = {}) => mapping.push({ sourceLines: row.sourceLines, sourceUuids: row.sourceUuids, targetSeq: event.seq, ...extra });
  const resultBlocks = (content, line) => {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    check(content === undefined || Array.isArray(content), 'TOOL_CONTENT', `第 ${line} 行工具结果内容不受支持。`);
    return (content || []).map(block => {
      if (block.type === 'image') return imageBlock(block, line);
      if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
      check(block.type === 'tool_reference', 'ATTACHMENT_UNSUPPORTED', `第 ${line} 行工具结果包含 ${block.type}，当前不支持。`);
      conversions.push({ line, type: 'tool_reference → JSON text', toolName: block.tool_name });
      return { type: 'text', text: JSON.stringify(block) };
    });
  };
  const imageBlock = (block, line) => {
    const image = options.attachments?.get(sha256(JSON.stringify(block)));
    check(image, 'ATTACHMENT_UNSUPPORTED', `第 ${line} 行图片尚未经过原生附件校验。`);
    conversions.push({ line, type: 'base64 image → native immutable attachment', attachmentId: image.ref.attachmentId });
    return { type: 'image', attachment: image.ref };
  };
  const humanParents = new Map();
  // The v4 persisted reader requires system updates to have a protected head.
  // Without this dormant node, a successful live resume can fail a cold read.
  const systemHead = { ...runtime.createSystemMessage(''), id: stableUuid(`${identity}/system-head`) };
  add('turn/start', { turn: 1 });
  add('step/start', { turn: 1, step: 1 });
  add('system/message', { turn: 1, step: 1, message: systemHead }, true);
  add('step/end', { turn: 1, step: 1 });
  add('turn/end', { turn: 1, reason: { kind: 'completed' } });
  turn = 1;
  const ordered = [];
  // A human can enqueue a prompt while parallel tools are still running.
  // Put their recorded results before that prompt, without crossing an assistant.
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.type === 'user' && !row.message.content.some(b => b.type === 'tool_result')) {
      const ahead = []; let j = i + 1;
      while (j < rows.length && rows[j].type === 'user') {
        if (!rows[j].moved && rows[j].message.content.every(b => b.type === 'tool_result')) ahead.push(rows[j]);
        j++;
      }
      if (ahead.length) {
        ordered.push(...ahead); for (const r of ahead) r.moved = true;
        conversions.push({ line: row.sourceLine, type: 'queued prompt after completed tool results', resultLines: ahead.flatMap(r => r.sourceLines) });
      }
    }
    if (!row.moved) ordered.push(row);
  }
  for (const row of ordered) {
    const blocks = row.message.content;
    if (row.type === 'user') {
      let humanStarted = false;
      const human = [];
      for (const [index, block] of blocks.entries()) {
        if (block.type !== 'tool_result') {
          check(block.type === 'image' || (block.type === 'text' && typeof block.text === 'string'), 'ATTACHMENT_UNSUPPORTED', `第 ${row.sourceLine} 行用户内容 ${block.type} 暂不支持。`);
          humanStarted = true; human.push(block.type === 'image' ? imageBlock(block, row.sourceLine) : block); continue;
        }
        check(!humanStarted, 'MIXED_CONTENT_ORDER', `第 ${row.sourceLine} 行工具结果出现在用户正文之后，无法安全确定轮次。`);
        const callId = activeCalls.get(block.tool_use_id) || block.tool_use_id;
        check(openStep && pending.has(callId), 'ORPHAN_RESULT', `第 ${row.sourceLine} 行工具结果没有对应的待完成调用。`);
        time = Date.parse(row.timestamp); pending.delete(callId); unresolvedCalls.delete(block.tool_use_id);
        const message = { ...runtime.createToolResultMessage({ callId, content: resultBlocks(block.content, row.sourceLine), isError: block.is_error === true }),
          id: stableUuid(`${input.sourceSessionId}/${row.sourceUuids[0]}/tool-result/${index}`) };
        record(row, add('tool/result', { turn, step, message }, true), { callId, sourceCallId: block.tool_use_id });
      }
      if (!human.length) continue;
      closeTurn(); time = Date.parse(row.timestamp); turn++; step = 0; openTurn = true; lastStop = undefined;
      add('turn/start', { turn });
      const message = { ...runtime.createUserMessage({ content: human, source: { kind: 'user' } }), id: stableUuid(`${input.sourceSessionId}/${row.sourceUuids[0]}/user`) };
      let placement = true;
      if (row.isCompactSummary) {
        check(row.compaction, 'COMPACTION_UNSUPPORTED', `第 ${row.sourceLine} 行摘要没有可验证的压缩边界。`);
        const uuids = row.compaction.preservedMessages?.allUuids ?? row.compaction.preservedMessages?.uuids;
        check(Array.isArray(uuids) && uuids.every(uuid => typeof uuid === 'string' && uuid.length),
          'COMPACTION_UNSUPPORTED', `第 ${row.sourceLine} 行压缩保留消息清单不是有效 UUID 数组。`);
        const preserved = new Set(uuids);
        const nodes = [...session.surface.nodes].filter(seq => events[seq].type !== 'system/message');
        const activeUuids = new Set(mapping.filter(m => nodes.includes(m.targetSeq)).flatMap(m => m.sourceUuids));
        // Claude's retained list can also include local commands and timing
        // records. They have no model-input node, but must exist before summary.
        check(uuids.every(uuid => activeUuids.has(uuid) || metadataUuids.get(uuid) < row.sourceLine),
          'COMPACTION_UNSUPPORTED', `第 ${row.sourceLine} 行压缩保留清单引用了无法映射的活动消息。`);
        const kept = new Set(mapping.filter(m => m.sourceUuids.some(uuid => preserved.has(uuid))).map(m => m.targetSeq));
        const firstKept = nodes.findIndex(seq => kept.has(seq));
        check(firstKept < 0 || nodes.slice(firstKept).every(seq => kept.has(seq) || events[seq].type === 'user/message'), 'COMPACTION_UNSUPPORTED', '压缩保留区间混有未声明的助手或工具消息。');
        const replaced = firstKept < 0 ? nodes : nodes.slice(0, firstKept);
        check(replaced.length, 'COMPACTION_UNSUPPORTED', '压缩边界没有可替换的旧上下文。');
        placement = { surfaceOp: { op: 'replace', startSeq: replaced[0], endSeq: replaced.at(-1) }, sourceEventSeqs: replaced };
        conversions.push({ line: row.sourceLine, type: 'Claude compact summary → native surface replacement', replacedMessages: replaced.length, preservedMessages: nodes.length - replaced.length });
      } else if (row.parentUuid && humanParents.has(row.parentUuid)) {
        const old = humanParents.get(row.parentUuid);
        check(session.surface.nodes.includes(old), 'BRANCH_UNSUPPORTED', '被替换的用户消息不在活动上下文中。');
        // Empty developer replacement retires only the old model input. Both
        // actual human prompts remain append-origin transcript records.
        const retired = { ...runtime.createDeveloperMessage({ content: [], source: { kind: 'user' } }), id: stableUuid(`${identity}/${row.sourceUuids[0]}/retire`) };
        step++;
        add('step/start', { turn, step });
        add('developer/message', { turn, step, message: retired }, { surfaceOp: { op: 'replace', startSeq: old, endSeq: old }, sourceEventSeqs: [old] });
        add('step/end', { turn, step });
        conversions.push({ line: row.sourceLine, type: '回复前修改用户消息 → native surface replacement', replacedSeq: old });
      }
      const userEvent = add('user/message', message, placement);
      record(row, userEvent);
      if (row.parentUuid && !row.isCompactSummary) humanParents.set(row.parentUuid, userEvent.seq);
      continue;
    }
    check(openTurn, 'ORPHAN_ASSISTANT', `第 ${row.sourceLine} 行助手消息没有对应用户轮次。`);
    closeStep(); time = Date.parse(row.timestamp); step++; openStep = true;
    add('step/start', { turn, step });
    const converted = blocks.map(block => {
      if (block.type === 'text' && typeof block.text === 'string') return { type: 'text', text: block.text };
      if (block.type === 'thinking' && typeof block.thinking === 'string') return { type: 'reasoning', text: block.thinking };
      check(block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string' && block.input && typeof block.input === 'object' && !Array.isArray(block.input),
        'BLOCK_UNSUPPORTED', `第 ${row.sourceLine} 行助手内容 ${block.type} 无法转换。`);
      let callId = block.id;
      check(!unresolvedCalls.has(block.id), 'DUPLICATE_CALL', `工具调用 ID ${block.id} 在完成前重复。`);
      if (callIds.has(callId)) {
        callId = `import-${stableUuid(`${identity}/${row.sourceUuids[0]}/${block.id}`)}`;
        conversions.push({ line: row.sourceLine, type: 'reused tool call ID → unique occurrence ID', sourceCallId: block.id, callId });
      }
      check(!callIds.has(callId), 'DUPLICATE_CALL', `工具调用 ID ${block.id} 无法唯一映射。`);
      callIds.add(callId); activeCalls.set(block.id, callId); pending.set(callId, row.sourceLine); unresolvedCalls.add(block.id);
      return { type: 'tool-call', id: callId, name: block.name, arguments: JSON.stringify(block.input) };
    });
    check(typeof row.message.model === 'string', 'MODEL_METADATA', `第 ${row.sourceLine} 行缺少原模型名称。`);
    const stream = new runtime.AssistantStreamAccumulator();
    converted.forEach((block, index) => {
      const push = chunk => stream.push({ time: row.blockTimes[index], chunk });
      push({ type: 'block-start', index, blockType: block.type });
      if (['text', 'reasoning'].includes(block.type)) push({ type: `${block.type}-delta`, index, text: block.text });
      else push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments });
      push({ type: 'block-end', index, block });
    });
    lastStop = row.message.stop_reason;
    const finish = converted.some(b => b.type === 'tool-call') ? 'tool-calls' : lastStop === 'max_tokens' ? 'max-tokens' : 'stop';
    stream.push({ time, chunk: { type: 'finish', reason: { kind: finish } } });
    const message = { ...runtime.createAssistantMessage({ content: converted, source: { provider: 'claude-code', model: row.message.model } }),
      id: stableUuid(`${input.sourceSessionId}/${row.sourceUuids[0]}/assistant`) };
    record(row, add('assistant/message', { turn, step, message, stream: stream.snapshot() }, true), { claudeMessageId: row.message.id || null });
    for (const block of converted.filter(b => b.type === 'tool-call')) {
      add('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments });
    }
  }
  closeTurn();
  add('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
  const restored = runtime.Session.create(id, events, header);
  const counts = { users: 0, assistants: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };
  for (const event of events.filter(e => e.surfaceOp === 'append')) {
    const message = restored.deriveEventMessage(event);
    if (!message) continue;
    if (message.role === 'user') counts.users++;
    if (message.role === 'assistant') counts.assistants++;
    if (message.role === 'tool') counts.toolResults++;
    for (const block of message.content) { if (block.type === 'reasoning') counts.reasoning++; if (block.type === 'tool-call') counts.toolCalls++; }
  }
  return { header, events, title, counts, mapping, skipped, conversions, warnings,
    limitations: ['token 流及延迟为重建，非原始逐 token 数据', 'Claude 运行元数据、签名和用量仅在来源备份保留', '不支持文件及已有回答的复杂分支', ...(input.agentId ? ['子代理为独立历史会话，来源父 ID 保留在清单，不恢复正在运行的委派任务'] : [])],
    preview: restored.deriveMessages().map(message => ({ role: message.role, content: message.content })) };
}
