import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { planImport, importSession, verifySession } from '../src/manager.mjs';
import { batchImport } from '../src/batch.mjs';
import { loadRuntime, withStore, exists } from '../src/runtime.mjs';
import { transcript, jsonl } from './fixtures.mjs';

let root, runtime, samplePng, seq = 0;
before(async () => {
  await mkdir(new URL('../tmp/tests/', import.meta.url), { recursive: true });
  root = await mkdtemp(fileURLToPath(new URL('../tmp/tests/update-', import.meta.url)));
  runtime = await loadRuntime();
  const require = createRequire(runtime.packagePath);
  samplePng = await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#00aa00' } }).png().toBuffer();
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const iso = sec => `2026-11-25T01:00:${String(sec).padStart(2, '0')}.000Z`;
const defaultWorkspace = resolve('/workspace');

function agyRows(turns = 1) {
  const rows = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(0), content: '第一轮提问' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(1), model: 'gemini-4-neon-high', content: '第一轮回答' },
  ];
  if (turns >= 2) {
    rows.push(
      { step_index: 2, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(2), content: '第二轮提问' },
      { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(3), model: 'gemini-4-neon-high',
        tool_calls: [{ name: 'read_file', args: { Path: '/workspace/a.txt' } }] },
      { step_index: 4, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(4), content: '文件内容' },
      { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(5), model: 'gemini-4-neon-high', content: '第二轮回答' },
    );
  }
  if (turns >= 3) {
    rows.push(
      { step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(6), content: '第三轮提问' },
      { step_index: 7, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(7), model: 'gemini-4-neon-high', content: '第三轮回答' },
    );
  }
  return rows;
}

async function setupAgy(rows = agyRows(1), id = 'aaaaaaaa-1111-2222-3333-444444444444') {
  const dir = join(root, String(++seq));
  const sourceRoot = join(dir, 'antigravity-cli');
  const brainDir = join(sourceRoot, 'brain', id);
  const logDir = join(brainDir, '.system_generated', 'logs');
  await mkdir(logDir, { recursive: true });
  const source = join(logDir, 'transcript_full.jsonl');
  await writeFile(source, jsonl(rows));
  const db = new DatabaseSync(join(sourceRoot, 'conversation_summaries.db'));
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id text PRIMARY KEY, title text NOT NULL DEFAULT "", step_count integer NOT NULL DEFAULT 0,
    workspace_uris text NOT NULL DEFAULT "[]", status text NOT NULL DEFAULT "CASCADE_RUN_STATUS_IDLE",
    parent_conversation_id text NOT NULL DEFAULT "", nesting_depth integer NOT NULL DEFAULT 0,
    agent_name text NOT NULL DEFAULT "", not_fully_idle numeric NOT NULL DEFAULT 0
  )`);
  db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, step_count, workspace_uris) VALUES (?, ?, ?, ?)`)
    .run(id, '增量更新测试', rows.length, JSON.stringify([pathToFileURL(defaultWorkspace).href]));
  db.close();
  return { dir, brainDir, source, options: { from: 'agy', sourceRoot, targetRoot: join(dir, 'sessions'), dataDir: join(dir, 'data') } };
}

async function setupClaude(rows = transcript('claude-update')) {
  const dir = join(root, String(++seq));
  const claudeRoot = join(dir, 'projects'), project = join(claudeRoot, 'demo');
  await mkdir(project, { recursive: true });
  const source = join(project, 'session.jsonl');
  await writeFile(source, jsonl(rows));
  return { dir, source, options: { claudeRoot, targetRoot: join(dir, 'sessions'), dataDir: join(dir, 'data') } };
}

test('fast-forward --update appends new turns across chained updates and new media while preserving strict default without --update', async () => {
  const { brainDir, source, options } = await setupAgy(agyRows(1));
  const first = await importSession(source, { ...options, write: true });
  assert.equal(first.status, 'imported');

  // Append turn 2 with a new local image in tool result.
  const rows2 = agyRows(2);
  const stepDir = join(brainDir, '.system_generated', 'steps', '4');
  await mkdir(stepDir, { recursive: true });
  const imgPath = join(stepDir, 'new.png');
  await writeFile(imgPath, samplePng);
  rows2[4].media = [{ mime_type: 'image/png', uri: pathToFileURL(imgPath).href }];
  await writeFile(source, jsonl(rows2));

  // Without --update, strict behavior still rejects with TARGET_CONFLICT.
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'TARGET_CONFLICT' });

  // Preview with --update does not write.
  const preview = await importSession(source, { ...options, update: true });
  assert.equal(preview.status, 'preview-update');
  assert(preview.appendedEvents > 0);
  assert.equal((await verifySession(first.id, options)).currentEvents, first.eventCount);

  // Apply update #1.
  const updated1 = await importSession(source, { ...options, write: true, update: true });
  assert.equal(updated1.status, 'updated');
  assert.equal(updated1.id, first.id);
  assert(updated1.appendedEvents > 0);
  const v1 = await verifySession(first.id, options);
  assert.equal(v1.importedPrefixMatches, true);
  assert.equal(v1.imagesVerified, 1);
  assert.equal(v1.sourceState, 'unchanged');

  // Re-running --update on unchanged source is idempotent.
  assert.equal((await importSession(source, { ...options, write: true, update: true })).status, 'already-imported');

  // Chained update #2 (turn 3 added).
  const rows3 = agyRows(3);
  rows3[4].media = [{ mime_type: 'image/png', uri: pathToFileURL(imgPath).href }];
  await writeFile(source, jsonl(rows3));
  const updated2 = await importSession(source, { ...options, write: true, update: true });
  assert.equal(updated2.status, 'updated');
  assert.equal(updated2.id, first.id);
  const v2 = await verifySession(first.id, options);
  assert.equal(v2.importedPrefixMatches, true);
  assert.equal(v2.imagesVerified, 1);
  assert(v2.importedEvents > v1.importedEvents);
});

test('fast-forward --update treats dsh system-prompt head refresh on open as non-diverged and appends cleanly', async () => {
  const { source, options } = await setupAgy(agyRows(1));
  const first = await importSession(source, { ...options, write: true });

  // Simulate opening the session in dsh: appends a 5-event system/message head replacement turn.
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(first.id, 'read');
    const { events } = await reader.read(), header = reader.header;
    await reader.close();
    const session = runtime.Session.create(first.id, events, header), head = session.surface.nodes[0];
    const nextTurn = Math.max(...events.map(e => e.data?.turn || 0)) + 1;
    session.append('turn/start', { turn: nextTurn });
    session.append('step/start', { turn: nextTurn, step: 1 });
    session.append('system/message', { turn: nextTurn, step: 1, message: runtime.createSystemMessage('Opened in dsh') },
      { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] });
    session.append('step/end', { turn: nextTurn, step: 1 });
    session.append('turn/end', { turn: nextTurn, reason: { kind: 'completed' } });
    const writer = await store.open(first.id, 'write');
    try { await writer.append(session.snapshotEvents(events.length)); } finally { await writer.close(); }
  });

  // Source grows with turn 2.
  await writeFile(source, jsonl(agyRows(2)));
  const updated = await importSession(source, { ...options, write: true, update: true });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.id, first.id);
  const v = await verifySession(first.id, options);
  assert.equal(v.importedPrefixMatches, true);
  assert.equal(v.continued, false);

  // Chained update #2 still succeeds after the interleaved system-head turn!
  await writeFile(source, jsonl(agyRows(3)));
  const updated2 = await importSession(source, { ...options, write: true, update: true });
  assert.equal(updated2.status, 'updated');
  assert.equal((await verifySession(first.id, options)).importedPrefixMatches, true);
});

test('target continuation in dsh causes --update to skip by default and fork deterministically with --on-conflict new', async () => {
  const { source, options } = await setupAgy(agyRows(1));
  const first = await importSession(source, { ...options, write: true });

  // Simulate real user continuation in dsh.
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(first.id, 'read');
    const { events } = await reader.read(), header = reader.header;
    await reader.close();
    const session = runtime.Session.create(first.id, events, header);
    const nextTurn = Math.max(...events.map(e => e.data?.turn || 0)) + 1;
    session.append('turn/start', { turn: nextTurn });
    session.append('user/message', runtime.createUserMessage({ content: [{ type: 'text', text: '我在 dsh 里继续问了' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
    session.append('turn/end', { turn: nextTurn, reason: { kind: 'interrupted' } });
    const writer = await store.open(first.id, 'write');
    try { await writer.append(session.snapshotEvents(events.length)); } finally { await writer.close(); }
  });

  // Source also grows with turn 2 → diverged!
  await writeFile(source, jsonl(agyRows(2)));

  const skipped = await importSession(source, { ...options, write: true, update: true });
  assert.equal(skipped.status, 'skipped-conflict');
  assert.equal(skipped.ok, true);
  assert.equal(skipped.conflictReason, 'target-continued');

  // Preview fork does not write.
  const previewFork = await importSession(source, { ...options, update: true, onConflict: 'new' });
  assert.equal(previewFork.status, 'preview-fork');
  assert.notEqual(previewFork.id, first.id);

  // Apply fork creates a new deterministic session and leaves original untouched.
  const forked = await importSession(source, { ...options, write: true, update: true, onConflict: 'new' });
  assert.equal(forked.status, 'forked');
  assert.notEqual(forked.id, first.id);
  assert.equal(forked.forkedFrom, first.id);
  assert.equal(forked.conflictReason, 'target-continued');
  assert.equal((await verifySession(forked.id, options)).importedPrefixMatches, true);
  assert.equal((await verifySession(first.id, options)).continued, true);

  // Re-running --on-conflict new on the same snapshot is idempotent (no duplicate fork).
  const repeat = await importSession(source, { ...options, write: true, update: true, onConflict: 'new' });
  assert.equal(repeat.status, 'already-imported');
  assert.equal(repeat.id, forked.id);
});

test('source history rewrite triggers skipped-conflict by default and forks with --on-conflict new (including Claude)', async () => {
  const rows = transcript('claude-diverge');
  const { source, options } = await setupClaude(rows);
  const first = await importSession(source, { ...options, write: true });

  // Append a clean second turn to Claude → fast-forward update works on Claude too!
  const rows2 = [
    ...rows,
    { ...rows[1], uuid: 'u2', timestamp: '2026-10-01T00:00:10.000Z', message: { role: 'user', content: '第二轮' } },
    { ...rows[5], uuid: 'a4', timestamp: '2026-10-01T00:00:11.000Z', message: { id: 'msg-a4', role: 'assistant', model: 'fixture-model', stop_reason: 'end_turn', content: [{ type: 'text', text: '收到第二轮' }] } },
  ];
  await writeFile(source, jsonl(rows2));
  const updated = await importSession(source, { ...options, write: true, update: true });
  assert.equal(updated.status, 'updated');
  assert.equal((await verifySession(first.id, options)).importedPrefixMatches, true);

  // Now rewrite an earlier message → prefix-diverged!
  const rewritten = structuredClone(rows2);
  rewritten[5].message.content = [{ type: 'text', text: '被改写的旧回复' }];
  await writeFile(source, jsonl(rewritten));

  const skipped = await importSession(source, { ...options, write: true, update: true });
  assert.equal(skipped.status, 'skipped-conflict');
  assert.equal(skipped.conflictReason, 'prefix-diverged');

  const forked = await importSession(source, { ...options, write: true, update: true, onConflict: 'new' });
  assert.equal(forked.status, 'forked');
  assert.notEqual(forked.id, first.id);
  assert.equal((await verifySession(forked.id, options)).importedPrefixMatches, true);
});

test('batch --update reports updated/forked/conflicts totals and CLI validates --on-conflict usage', async () => {
  const { source, options } = await setupAgy(agyRows(1), '11111111-1111-1111-1111-111111111111');
  await importSession(source, { ...options, write: true });

  // Create a second session that will diverge.
  const id2 = '22222222-2222-2222-2222-222222222222';
  const logDir2 = join(options.sourceRoot, 'brain', id2, '.system_generated', 'logs');
  await mkdir(logDir2, { recursive: true });
  const source2 = join(logDir2, 'transcript_full.jsonl');
  await writeFile(source2, jsonl(agyRows(1)));
  const db = new DatabaseSync(join(options.sourceRoot, 'conversation_summaries.db'));
  db.prepare(`INSERT INTO conversation_summaries (conversation_id, title, step_count, workspace_uris) VALUES (?, ?, ?, ?)`)
    .run(id2, '分叉测试', 2, JSON.stringify([pathToFileURL(defaultWorkspace).href]));
  db.close();
  await importSession(source2, { ...options, write: true });

  // Session 1: clean append. Session 2: rewrite earlier reply.
  await writeFile(source, jsonl(agyRows(2)));
  const diverged = agyRows(1);
  diverged[1].content = '改写旧回答';
  await writeFile(source2, jsonl(diverged));

  const repSkip = await batchImport({ ...options, write: true, update: true });
  assert.equal(repSkip.ok, true);
  assert.equal(repSkip.totals.updated, 1);
  assert.equal(repSkip.totals.conflicts, 1);
  assert.equal(repSkip.totals.failed, 0);

  const repFork = await batchImport({ ...options, write: true, update: true, onConflict: 'new' });
  assert.equal(repFork.ok, true);
  assert.equal(repFork.totals.existing, 1);
  assert.equal(repFork.totals.forked, 1);
  assert.equal(repFork.totals.failed, 0);

  // CLI rejects --on-conflict without --update or invalid value.
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const bad1 = spawnSync(process.execPath, ['bin/sessions2dsh.mjs', 'batch', '--on-conflict', 'new'], { cwd, encoding: 'utf8' });
  assert.equal(bad1.status, 1);
  assert.match(bad1.stderr, /USAGE/);
  const bad2 = spawnSync(process.execPath, ['bin/sessions2dsh.mjs', 'batch', '--update', '--on-conflict', 'invalid'], { cwd, encoding: 'utf8' });
  assert.equal(bad2.status, 1);
  assert.match(bad2.stderr, /USAGE/);
});

test('fast-forward --update treats dsh open/config events (permission/sandbox/approval/model) as non-dialogue and adopts unmanaged targets', async () => {
  const { source, options } = await setupAgy(agyRows(1));
  const first = await importSession(source, { ...options, write: true });

  // Simulate dsh Desktop/Web opening the session (appends end-seed + preset/sandbox/approval/model).
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(first.id, 'read');
    const { events } = await reader.read(), header = reader.header;
    await reader.close();
    const s = runtime.Session.create(first.id, events, header);
    s.append('permission/preset', { preset: 'default' });
    s.append('sandbox/mode', { mode: 'workspace-write' });
    s.append('approval/policy', { policy: 'on-request' });
    s.append('model/selection', { provider: 'deepseek', model: 'deepseek-reasoner' });
    const w = await store.open(first.id, 'write');
    try { await w.append(s.snapshotEvents(events.length)); } finally { await w.close(); }
  });

  // Remove dataDir to simulate a session previously imported from another tool/dataDir (unmanaged).
  await rm(options.dataDir, { recursive: true, force: true });

  // Source grows with turn 2.
  await writeFile(source, jsonl(agyRows(2)));
  const preview = await importSession(source, { ...options, update: true });
  assert.equal(preview.status, 'preview-update');
  assert(preview.appendedEvents > 0);

  const updated = await importSession(source, { ...options, write: true, update: true });
  assert.equal(updated.status, 'updated');
  assert.equal(updated.id, first.id);
  const v = await verifySession(first.id, options);
  assert.equal(v.importedPrefixMatches, true);

  // Chained update #2 works cleanly now that it is adopted into dataDir.
  await writeFile(source, jsonl(agyRows(3)));
  const updated2 = await importSession(source, { ...options, write: true, update: true });
  assert.equal(updated2.status, 'updated');
  assert.equal((await verifySession(first.id, options)).importedPrefixMatches, true);
});
