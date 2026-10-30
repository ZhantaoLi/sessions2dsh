import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { check } from './errors.mjs';
import { sha256 } from './claude.mjs';

// Only the previous reviewed v4 receipt is accepted. Recovery creates a new
// session and leaves the old native artifact and its continuation untouched.
export async function recoverLegacy(receipt, plan, runtime, targetRoot) {
  check(/^session-[a-f0-9-]{36}$/.test(receipt.id) && receipt.header?.cwd?.startsWith('/'), 'REUSE_RECEIPT', '旧凭据 ID/cwd 无效。');
  const group = `--${receipt.header.cwd.slice(1).replaceAll('/', '-')}--`;
  const path = join(targetRoot, group, receipt.id, 'session.v4.jsonl.zstd');
  const bytes = await readFile(path);
  // zstd CLI handles the concatenated frames that Node's one-shot API stops at.
  const { stdout } = await promisify(execFile)('zstd', ['--decompress', '--stdout', '--', path], { maxBuffer: 64 * 1024 * 1024 });
  check(sha256(await readFile(path)) === sha256(bytes), 'SOURCE_CHANGED', '旧会话在恢复读取期间发生变化。');
  const [physical, ...events] = stdout.trim().split('\n').map(JSON.parse);
  check(physical.id === receipt.id && physical.version === 4 && events.length >= receipt.events && events.every((e, i) => e.seq === i), 'REUSE_CONFLICT', '旧会话头、格式或事件序号不匹配。');
  const { type, ...header } = physical;
  const previous = runtime.Session.create(receipt.id, events.slice(0, receipt.events), header);
  const generated = runtime.Session.create(plan.header.id, plan.events, plan.header);
  const payloads = session => session.deriveMessages().filter(m => m.role !== 'system').map(({ role, content }) => ({ role, content }));
  check(header.cwd === plan.header.cwd && header.createdAt === plan.header.createdAt && isDeepStrictEqual(payloads(previous), payloads(generated)), 'REUSE_CONFLICT', '旧会话消息与当前来源不一致，拒绝恢复。');
  const shift = seq => seq >= 1 ? seq + 5 : seq;
  const shifted = events.map(raw => {
    const event = structuredClone(raw); event.seq = shift(event.seq);
    if (Number.isSafeInteger(event.data?.turn)) event.data.turn++;
    if (event.sourceEventSeqs) event.sourceEventSeqs = event.sourceEventSeqs.map(shift);
    if (event.surfaceOp && typeof event.surfaceOp === 'object') { event.surfaceOp.startSeq = shift(event.surfaceOp.startSeq); event.surfaceOp.endSeq = shift(event.surfaceOp.endSeq); }
    if (Array.isArray(event.data?.messageSeqs)) event.data.messageSeqs = event.data.messageSeqs.map(shift);
    return event;
  });
  shifted.splice(1, 0, ...plan.events.slice(1, 6));
  runtime.Session.create(plan.header.id, shifted, plan.header);
  plan.events = shifted; plan.title = receipt.title;
  plan.mapping = receipt.mapping.map(item => ({ ...item, targetSeq: shift(item.targetSeq) }));
  plan.legacyBackup = { path, bytes, sha256: sha256(bytes) };
  plan.conversions.push({ type: 'legacy corrupt system head → recovered new session with full continuation', originalId: receipt.id, originalEvents: events.length, continuationEvents: events.length - receipt.events });
}
