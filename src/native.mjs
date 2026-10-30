import { isAbsolute } from 'node:path';
import { stableUuid, targetSessionId } from './convert.mjs';
import { check } from './errors.mjs';

// Source-neutral items: user, assistant (one model step), or tool result.
// Claude's established converter stays frozen to preserve published prefixes.
export function buildNativeSession(input, runtime, { items, cwd, title, skipped = [], warnings = [], conversions = [] }, options = {}) {
  check(isAbsolute(cwd || ''), 'SOURCE_CWD', '来源没有绝对工作目录；请用 --cwd 明确指定。');
  check(items.length && items[0].kind === 'user', 'NO_USER_MESSAGE', '没有可导入的用户对话，或历史未从用户消息开始。');
  // The `agent-sessions/...` namespace feeds the derived target session ID. Do not
  // rename it with the project: changing it would make published sessions look new.
  const identity = `agent-sessions/${input.sourceKind}/v1/${input.sourceSessionId}${input.agentId ? `/agent/${input.agentId}` : ''}`;
  const id = targetSessionId(input);
  const clean = (options.title || title).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  title = ''; for (const char of clean) { if (Buffer.byteLength(title + char) > 120) break; title += char; }
  check(title, 'TITLE', '标题不能为空。');
  const header = { version: 4, id, createdAt: items[0].time, cwd, isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };
  const session = runtime.Session.create(id, [], header);
  const events = session.snapshotEvents().map(e => ({ ...e, time: header.createdAt }));
  const mapping = [], pending = new Map(), usedCalls = new Set(), activeCalls = new Map();
  let time = header.createdAt, turn = 1, step = 0, openTurn = false, openStep = false, completed = false;
  const add = (type, data, surface = false) => {
    const event = { ...session.append(type, data, ...(surface ? [{ surfaceOp: 'append' }] : [])), time };
    events.push(event); return event;
  };
  const messageId = (item, kind) => stableUuid(`${identity}/${item.ids.join('/')}/${kind}`);
  const record = (item, event) => mapping.push({ sourceLines: item.lines, sourceIds: item.ids, targetSeq: event.seq });
  const closeStep = () => {
    if (!openStep) return;
    if (pending.size && options.repairInterrupted) {
      for (const callId of pending.keys()) {
        const message = { ...runtime.createToolResultMessage({ callId, isError: true, content: [{ type: 'text', text: `[${input.sourceKind} import recovery] No tool result was recorded in the source. The outcome is unknown. Verify external state before retrying operations with side effects.` }] }), id: stableUuid(`${identity}/recovery/${callId}`) };
        add('tool/result', { turn, step, message }, true);
        conversions.push({ type: 'missing tool result → explicit unknown-outcome error', callId });
      }
      pending.clear();
    }
    check(!pending.size, 'UNFINISHED_TOOL', `工具调用缺少结果：${[...pending.keys()].join(', ')}；可明确选择 --repair-interrupted。`);
    add('step/end', { turn, step }); openStep = false;
  };
  const closeTurn = () => {
    if (!openTurn) return;
    closeStep();
    add('turn/end', { turn, reason: { kind: completed ? 'completed' : 'interrupted' } });
    if (!completed) warnings.push(`第 ${turn} 轮缺少完整助手回复，按 interrupted 保留。`);
    openTurn = false;
  };
  add('turn/start', { turn }); add('step/start', { turn, step: 1 });
  add('system/message', { turn, step: 1, message: { ...runtime.createSystemMessage(''), id: stableUuid(`${identity}/system-head`) } }, true);
  add('step/end', { turn, step: 1 }); add('turn/end', { turn, reason: { kind: 'completed' } });
  for (const item of items) {
    if (item.kind === 'user') {
      closeTurn(); time = item.time; turn++; step = 0; openTurn = true; completed = false;
      add('turn/start', { turn });
      record(item, add('user/message', { ...runtime.createUserMessage({ content: item.content, source: { kind: 'user' } }), id: messageId(item, 'user') }, true));
    } else if (item.kind === 'context') {
      check(openTurn, 'ORPHAN_CONTEXT', `第 ${item.lines[0]} 行注入上下文没有用户轮次。`);
      time = item.time;
      record(item, add('user/message', { ...runtime.createUserMessage({ content: item.content, source: { kind: 'user' } }), id: messageId(item, 'context') }, true));
    } else if (item.kind === 'result') {
      const callId = activeCalls.get(item.callId);
      check(openStep && pending.has(callId), 'ORPHAN_RESULT', `第 ${item.lines[0]} 行工具结果没有对应的待完成调用。`);
      check(pending.get(callId) === item.name, 'TOOL_NAME', `第 ${item.lines[0]} 行工具名称与调用不符。`);
      time = item.time; pending.delete(callId);
      record(item, add('tool/result', { turn, step, message: { ...runtime.createToolResultMessage({ callId, content: item.content, isError: item.isError }), id: messageId(item, 'result') } }, true));
    } else {
      check(openTurn, 'ORPHAN_ASSISTANT', `第 ${item.lines[0]} 行助手消息没有用户轮次。`);
      closeStep(); time = item.time; step++; openStep = true;
      add('step/start', { turn, step });
      const content = structuredClone(item.content);
      for (const block of content.filter(b => b.type === 'tool-call')) {
        const original = block.id;
        check(!pending.has(activeCalls.get(original)), 'DUPLICATE_CALL', `工具调用 ${original} 在完成前重复。`);
        if (usedCalls.has(original)) {
          block.id = `import-${stableUuid(`${identity}/${item.ids.join('/')}/${original}`)}`;
          conversions.push({ line: item.lines[0], type: 'reused tool call ID → unique occurrence ID', sourceCallId: original, callId: block.id });
        }
        check(!usedCalls.has(block.id), 'DUPLICATE_CALL', '同一步存在重复工具调用。');
        usedCalls.add(block.id); activeCalls.set(original, block.id); pending.set(block.id, block.name);
      }
      const stream = new runtime.AssistantStreamAccumulator();
      content.forEach((block, index) => {
        const push = chunk => stream.push({ time: item.blockTimes[index], chunk });
        push({ type: 'block-start', index, blockType: block.type });
        if (block.type === 'tool-call') push({ type: 'tool-call-delta', index, id: block.id, name: block.name, argumentsDelta: block.arguments });
        else push({ type: `${block.type}-delta`, index, text: block.text });
        push({ type: 'block-end', index, block });
      });
      completed = item.completed && !pending.size;
      stream.push({ time, chunk: { type: 'finish', reason: { kind: pending.size ? 'tool-calls' : 'stop' } } });
      const message = { ...runtime.createAssistantMessage({ content, source: { provider: input.sourceKind, model: item.model } }), id: messageId(item, 'assistant') };
      record(item, add('assistant/message', { turn, step, message, stream: stream.snapshot() }, true));
      for (const block of content.filter(b => b.type === 'tool-call')) add('tool/call', { turn, step, callId: block.id, name: block.name, arguments: block.arguments });
    }
  }
  closeTurn(); add('session/title', { title, messageSeqs: [], source: { kind: 'user' } });
  const restored = runtime.Session.create(id, events, header);
  const counts = { users: 0, assistants: 0, toolCalls: 0, toolResults: 0, reasoning: 0 };
  for (const item of items) {
    if (item.kind === 'user' || item.kind === 'context') counts.users++;
    else if (item.kind === 'result') counts.toolResults++;
    else { counts.assistants++; counts.reasoning += item.content.filter(b => b.type === 'reasoning').length; counts.toolCalls += item.content.filter(b => b.type === 'tool-call').length; }
  }
  counts.toolResults += conversions.filter(c => c.type.startsWith('missing tool result')).length;
  return { header, events, title, mapping, skipped, warnings, conversions, counts,
    limitations: ['token 流与耗时为重建，非来源原始逐 token 数据', '运行配置、签名、用量和列表摘要仅在原件备份中保留', '真实压缩、复杂分支和未知内容块暂不支持'],
    preview: restored.deriveMessages().map(({ role, content }) => ({ role, content })) };
}
