import { isDeepStrictEqual } from 'node:util';
import { stableUuid } from './convert.mjs';

const nonDialogueTypes = new Set([
  'session/end-seed', 'turn/start', 'step/start', 'system/message', 'step/end', 'turn/end',
  'session/title', 'permission/preset', 'sandbox/mode', 'approval/policy', 'model/selection',
]);

export function stripTrailingTitle(events) {
  return events.length && events.at(-1)?.type === 'session/title' ? events.slice(0, -1) : events;
}

export function inferStoredPrefix(stored) {
  const titleIndex = stored.events.findIndex(event => event.type === 'session/title');
  return titleIndex >= 0 ? stored.events.slice(0, titleIndex + 1) : stored.events;
}

export function isNonDialogueTail(tailEvents) {
  let openTurn = false;
  let openStep = false;
  for (const event of tailEvents) {
    if (!nonDialogueTypes.has(event.type)) return false;
    if (event.type === 'turn/start') {
      if (openTurn) return false;
      openTurn = true;
    } else if (event.type === 'turn/end') {
      if (!openTurn || openStep) return false;
      openTurn = false;
    } else if (event.type === 'step/start') {
      if (!openTurn || openStep) return false;
      openStep = true;
    } else if (event.type === 'step/end') {
      if (!openStep) return false;
      openStep = false;
    } else if (event.type === 'system/message') {
      if (!openStep) return false;
    } else if (openTurn || openStep) {
      return false;
    }
  }
  return !openTurn && !openStep;
}

export function defaultSegments(oldEvents) {
  const end = stripTrailingTitle(oldEvents).length;
  return [{ canonicalStart: 0, canonicalEnd: end, targetStart: 0, turnOffset: 0 }];
}

function mapCanonicalSeq(seq, segments, nextTargetStart, totalCanonical) {
  if (seq >= totalCanonical) return nextTargetStart + (seq - totalCanonical);
  for (const segment of segments) {
    if (seq >= segment.canonicalStart && seq < segment.canonicalEnd) {
      return segment.targetStart + (seq - segment.canonicalStart);
    }
  }
  return seq;
}

function shiftEvent(raw, segments, nextTargetStart, totalCanonical, turnOffset) {
  const event = structuredClone(raw);
  event.seq = mapCanonicalSeq(event.seq, segments, nextTargetStart, totalCanonical);
  if (turnOffset !== 0 && Number.isSafeInteger(event.data?.turn)) {
    event.data.turn += turnOffset;
  }
  if (Array.isArray(event.sourceEventSeqs)) {
    event.sourceEventSeqs = event.sourceEventSeqs.map(seq => mapCanonicalSeq(seq, segments, nextTargetStart, totalCanonical));
  }
  if (event.surfaceOp && typeof event.surfaceOp === 'object') {
    if (Number.isSafeInteger(event.surfaceOp.startSeq)) {
      event.surfaceOp.startSeq = mapCanonicalSeq(event.surfaceOp.startSeq, segments, nextTargetStart, totalCanonical);
    }
    if (Number.isSafeInteger(event.surfaceOp.endSeq)) {
      event.surfaceOp.endSeq = mapCanonicalSeq(event.surfaceOp.endSeq, segments, nextTargetStart, totalCanonical);
    }
  }
  if (Array.isArray(event.data?.messageSeqs)) {
    event.data.messageSeqs = event.data.messageSeqs.map(seq => mapCanonicalSeq(seq, segments, nextTargetStart, totalCanonical));
  }
  return event;
}

function maxTurnOf(events) {
  let max = 0;
  for (const event of events) {
    if (Number.isSafeInteger(event.data?.turn) && event.data.turn > max) max = event.data.turn;
  }
  return max;
}

export function forkSessionId(input, snapshotSha) {
  const identity = `agent-sessions/${input.sourceKind || 'claude'}/v1/${input.sourceSessionId}${input.agentId ? `/agent/${input.agentId}` : ''}/snapshot/${snapshotSha}`;
  return `session-${stableUuid(identity)}`;
}

export function evaluateUpdate({ stored, oldEvents, manifest, plan, runtime }) {
  if (!isDeepStrictEqual(stored.header, plan.header)) {
    return { action: 'conflict', reason: 'header-changed', message: '目标会话头（cwd/创建时间/格式）与当前来源不一致。' };
  }
  if (stored.events.length < oldEvents.length || !isDeepStrictEqual(stored.events.slice(0, oldEvents.length), oldEvents)) {
    return { action: 'conflict', reason: 'target-modified', message: '目标会话已导入前缀与备份不一致。' };
  }
  const segments = Array.isArray(manifest?.segments) && manifest.segments.length ? manifest.segments : defaultSegments(oldEvents);
  const totalCanonical = segments.at(-1).canonicalEnd;
  const newDialogue = stripTrailingTitle(plan.events);
  if (newDialogue.length < totalCanonical) {
    return { action: 'conflict', reason: 'prefix-diverged', message: '源会话历史变短或被重写，无法安全追加。' };
  }
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const prior = segments.slice(0, i + 1);
    const len = seg.canonicalEnd - seg.canonicalStart;
    const expected = newDialogue
      .slice(seg.canonicalStart, seg.canonicalEnd)
      .map(event => shiftEvent(event, prior, seg.targetStart, seg.canonicalEnd, seg.turnOffset));
    const actual = oldEvents.slice(seg.targetStart, seg.targetStart + len);
    if (!isDeepStrictEqual(actual, expected)) {
      return { action: 'conflict', reason: 'prefix-diverged', message: '源会话已导入的历史前缀发生变化，无法原地追加。' };
    }
  }
  if (newDialogue.length === totalCanonical) {
    return { action: 'unchanged' };
  }
  const tailEvents = stored.events.slice(oldEvents.length);
  if (!isNonDialogueTail(tailEvents)) {
    return { action: 'conflict', reason: 'target-continued', message: '目标会话已在 dsh 中产生新对话，无法直接追加源更新。' };
  }
  const rawDelta = newDialogue.slice(totalCanonical);
  if (rawDelta[0]?.type !== 'turn/start' || !Number.isSafeInteger(rawDelta[0]?.data?.turn)) {
    return { action: 'conflict', reason: 'mid-turn-diverged', message: '新增事件未落在完整轮次边界，无法原地追加。' };
  }
  const nextTargetStart = stored.events.length;
  const turnOffset = (maxTurnOf(stored.events) + 1) - rawDelta[0].data.turn;
  const deltaEvents = rawDelta.map(event => shiftEvent(event, segments, nextTargetStart, totalCanonical, turnOffset));
  const combinedEvents = [...stored.events, ...deltaEvents];
  try {
    runtime.Session.create(stored.header.id, combinedEvents, stored.header);
  } catch (error) {
    return { action: 'conflict', reason: 'session-validation-diverged', message: `合并增量事件未通过 dsh 原生校验：${error.message}` };
  }
  const nextSegments = [...segments, { canonicalStart: totalCanonical, canonicalEnd: newDialogue.length, targetStart: nextTargetStart, turnOffset }];
  return { action: 'update', deltaEvents, combinedEvents, nextSegments };
}
