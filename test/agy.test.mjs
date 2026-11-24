import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { DatabaseSync } from 'node:sqlite';
import { planImport, importSession, verifySession, listSessions, doctor } from '../src/manager.mjs';
import { batchImport } from '../src/batch.mjs';
import { loadRuntime, withStore, exists } from '../src/runtime.mjs';

let root, runtime, samplePng, samplePng2, seq = 0;
before(async () => {
  await mkdir(new URL('../tmp/tests/', import.meta.url), { recursive: true });
  root = await mkdtemp(fileURLToPath(new URL('../tmp/tests/agy-', import.meta.url)));
  runtime = await loadRuntime();
  const require = createRequire(runtime.packagePath);
  const sharp = require('sharp');
  samplePng = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer();
  samplePng2 = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#00ff00' } }).png().toBuffer();
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });

const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const iso = sec => `2026-11-20T10:00:${String(sec).padStart(2, '0')}.000Z`;
const defaultWorkspace = resolve('/workspace');

function fixture() {
  return [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(0), content: '请检查这两个文件' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(1), model: 'gemini-4-neon-high',
      input_tokens: 100, cache_read_tokens: 50, output_tokens: 40, thinking: '先读取两个文件。',
      tool_calls: [{ name: 'read_file', args: { Path: '/workspace/a.txt' } }, { name: 'read_file', args: { Path: '/workspace/b.txt' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: iso(2), content: '文件A内容' },
    { step_index: 3, source: 'MODEL', type: 'GENERIC', status: 'ERROR', created_at: iso(3), content: 'Created At: 2026-11-20\nError: file does not exist', error: 'file does not exist' },
    { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: iso(4),
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\nReminder: work efficiently. In this turn, issue in parallel.\n</SYSTEM_MESSAGE>' },
    { step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(5), model: 'gemini-4-neon-high',
      input_tokens: 120, cache_read_tokens: 60, output_tokens: 30, thinking: '整理结果。', content: '文件A存在，文件B缺失。' },
  ];
}

function createSummaryDb(sourceRoot, summaries = []) {
  const dbPath = join(sourceRoot, 'conversation_summaries.db');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE conversation_summaries (
    conversation_id text PRIMARY KEY,
    title text NOT NULL DEFAULT "",
    preview text NOT NULL DEFAULT "",
    step_count integer NOT NULL DEFAULT 0,
    last_modified_time datetime NOT NULL DEFAULT "2026-11-20 10:00:05+00:00",
    workspace_uris text NOT NULL DEFAULT "[]",
    status text NOT NULL DEFAULT "CASCADE_RUN_STATUS_IDLE",
    source text NOT NULL DEFAULT "",
    project_id text NOT NULL DEFAULT "default-cli-project",
    agent_name text NOT NULL DEFAULT "",
    parent_conversation_id text NOT NULL DEFAULT "",
    nesting_depth integer NOT NULL DEFAULT 0,
    battle_id text NOT NULL DEFAULT "",
    winning_conversation_id text NOT NULL DEFAULT "",
    not_fully_idle numeric NOT NULL DEFAULT 0,
    killed numeric NOT NULL DEFAULT 0,
    last_user_input_time datetime NOT NULL DEFAULT "2026-11-20 10:00:00+00:00",
    last_user_input_step_index integer NOT NULL DEFAULT 0,
    app_data_dir text NOT NULL DEFAULT "antigravity-cli",
    raw_summary blob,
    group_id text NOT NULL DEFAULT ""
  )`);
  const insert = db.prepare(`INSERT INTO conversation_summaries
    (conversation_id, title, step_count, workspace_uris, status, parent_conversation_id, nesting_depth, agent_name, not_fully_idle)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const s of summaries) {
    insert.run(
      s.id,
      s.title ?? '',
      s.stepCount ?? 6,
      JSON.stringify(s.workspaceUris ?? [pathToFileURL(defaultWorkspace).href]),
      s.status ?? 'CASCADE_RUN_STATUS_IDLE',
      s.parentId ?? '',
      s.nestingDepth ?? 0,
      s.agentName ?? '',
      s.notFullyIdle ? 1 : 0,
    );
  }
  db.close();
  return dbPath;
}

async function writeConv(sourceRoot, id, rows) {
  const brainDir = join(sourceRoot, 'brain', id);
  const logDir = join(brainDir, '.system_generated', 'logs');
  await mkdir(logDir, { recursive: true });
  const source = join(logDir, 'transcript_full.jsonl');
  if (rows !== null) await writeFile(source, typeof rows === 'string' ? rows : jsonl(rows));
  return { brainDir, source };
}

async function setup(rows = fixture(), { id = '11111111-2222-3333-4444-555555555555', summary = {}, withDb = true } = {}) {
  const dir = join(root, String(++seq));
  const sourceRoot = join(dir, 'antigravity-cli');
  await mkdir(sourceRoot, { recursive: true });
  const { brainDir, source } = await writeConv(sourceRoot, id, rows);
  if (withDb) createSummaryDb(sourceRoot, [{ id, title: '检查示例文件', stepCount: Array.isArray(rows) ? rows.length : 0, ...summary }]);
  return { dir, sourceRoot, brainDir, source, options: { from: 'agy', sourceRoot, targetRoot: join(dir, 'sessions'), dataDir: join(dir, 'data') } };
}

test('agy preview converts transcript_full.jsonl deterministically, skips reminders, and reads cwd/title from summary DB', async () => {
  const { source, brainDir, options } = await setup();
  const a = await planImport(source, { ...options, messages: true });
  const b = await planImport(brainDir, { ...options, from: 'antigravity' });
  assert.deepEqual(a.plan.events, b.plan.events);
  assert.equal(a.summary.sourceKind, 'agy');
  assert.equal(a.summary.cwd, defaultWorkspace);
  assert.equal(a.summary.title, '[Antigravity] 检查示例文件');
  assert.deepEqual(a.summary.counts, { users: 1, assistants: 2, toolCalls: 2, toolResults: 2, reasoning: 2 });
  assert.equal(a.plan.skipped.length, 1);
  assert(!JSON.stringify(a.plan.preview).includes('Reminder: work efficiently'));
  const messages = runtime.Session.create(a.plan.header.id, a.plan.events, a.plan.header).deriveMessages();
  const assistant = messages.find(m => m.role === 'assistant');
  assert.equal(assistant.source.provider, 'agy');
  assert.equal(assistant.source.model, 'gemini-4-neon-high');
  assert.deepEqual(JSON.parse(assistant.content.find(bl => bl.type === 'tool-call').arguments), { Path: '/workspace/a.txt' });
  const tools = messages.filter(m => m.role === 'tool');
  assert.equal(tools[0].isError, false);
  assert.equal(tools[1].isError, true);
  assert.match(tools[1].content[0].text, /file does not exist/);
  assert(!(await exists(options.targetRoot)));
  assert(!(await exists(options.dataDir)));
});

test('agy native import backs up originals, skips duplicates, preserves continuation, and stays separate from Claude/CodeBuddy', async () => {
  const { source, options } = await setup();
  const original = await readFile(source);
  const result = await importSession(source, { ...options, write: true });
  assert.equal(result.status, 'imported');
  assert.deepEqual(await readFile(join(result.backup, 'source.jsonl')), original);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await importSession(source, { ...options, write: true })).status, 'already-imported');
  await withStore(runtime, options.targetRoot, async store => {
    const writer = await store.open(result.id, 'write');
    try { await writer.append([{ seq: result.eventCount, time: Date.parse(iso(10)), type: 'session/title', data: { title: '续聊', source: { kind: 'user' }, messageSeqs: [] } }]); }
    finally { await writer.close(); }
  });
  const verified = await verifySession(result.id, options);
  assert.equal(verified.continued, true);
  assert.equal(verified.sourceState, 'unchanged');
  assert.equal((await importSession(source, { ...options, write: true })).status, 'already-imported');
  const modified = fixture();
  modified[5].content = '改变后的回复';
  await writeFile(source, jsonl(modified));
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'TARGET_CONFLICT' });
});

test('agy media images in tool results are normalized on preview, backed up and verified on import, and protected by snapshot SHA', async () => {
  const { brainDir, source, options } = await setup();
  const stepDir = join(brainDir, '.system_generated', 'steps', '2');
  await mkdir(stepDir, { recursive: true });
  const imgPath = join(stepDir, 'shot.png');
  await writeFile(imgPath, samplePng);
  const rows = fixture();
  rows[2].media = [{ mime_type: 'image/png', uri: pathToFileURL(imgPath).href }];
  await writeFile(source, jsonl(rows));

  const preview = await planImport(source, options);
  assert.equal(preview.attachments.size, 1);
  assert.equal(preview.summary.images, 1);
  assert.equal(preview.summary.sourceFiles.length, 1);
  assert(!(await exists(preview.options.attachmentHome)));
  assert(!(await exists(options.dataDir)));

  const result = await importSession(source, { ...options, write: true, expectSnapshotSha: preview.summary.snapshotSha256 });
  assert.equal(result.status, 'imported');
  const manifest = JSON.parse(await readFile(join(result.backup, 'manifest.json'), 'utf8'));
  assert.equal(manifest.sourceFiles.length, 1);
  assert.deepEqual(await readFile(join(result.backup, manifest.sourceFiles[0].backup)), samplePng);
  const verified = await verifySession(result.id, options);
  assert.equal(verified.imagesVerified, 1);
  assert.equal(verified.sourceState, 'unchanged');

  await writeFile(imgPath, samplePng2);
  assert.equal((await verifySession(result.id, options)).sourceState, 'changed');
  await assert.rejects(importSession(source, { ...options, write: true, expectSnapshotSha: preview.summary.snapshotSha256 }), { code: 'SOURCE_CHANGED' });

  await writeFile(join(result.backup, manifest.sourceFiles[0].backup), Buffer.from('corrupt'));
  await assert.rejects(verifySession(result.id, options), { code: 'BACKUP_CHANGED' });
});

test('agy rejects missing or escaping media by default, and degrades cleanly under --best-effort for missing media', async () => {
  const kinds = process.platform === 'win32' ? ['missing', 'outside'] : ['missing', 'outside', 'symlink'];
  for (const kind of kinds) {
    const { dir, brainDir, source, options } = await setup();
    const stepDir = join(brainDir, '.system_generated', 'steps', '2');
    await mkdir(stepDir, { recursive: true });
    let target;
    if (kind === 'missing') {
      target = join(stepDir, 'missing.png');
    } else if (kind === 'outside') {
      target = join(dir, 'outside.png');
      await writeFile(target, samplePng);
    } else {
      const outside = join(dir, 'secret.png');
      await writeFile(outside, samplePng);
      target = join(stepDir, 'link.png');
      await symlink(outside, target);
    }
    const rows = fixture();
    rows[2].media = [{ mime_type: 'image/png', uri: pathToFileURL(target).href }];
    await writeFile(source, jsonl(rows));
    await assert.rejects(importSession(source, { ...options, write: true }), { code: 'EXTERNAL_RESULT' });
    assert(!(await exists(options.targetRoot)));
    assert(!(await exists(options.dataDir)));
    if (kind === 'missing') {
      const plan = await planImport(source, { ...options, bestEffort: true });
      assert(plan.summary.warnings.some(w => /媒体附件不可读/.test(w)));
      assert(plan.summary.conversions.some(c => /media unreadable/.test(c.type)));
      const res = await importSession(source, { ...options, bestEffort: true, write: true });
      assert.equal(res.status, 'imported');
    }
  }
});

test('agy preserves async [Message] SYSTEM_MESSAGE as unwrapped developer message, skips server restart notices, and supports cold read', async () => {
  const rows = [
    { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(0), content: '跑一个后台任务' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(1), model: 'gemini-4-neon-high',
      tool_calls: [{ name: 'run_command', args: { CommandLine: 'sleep 1' } }] },
    { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'RUNNING', created_at: iso(2), content: 'Command running in background (task-2)' },
    { step_index: 3, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(3), model: 'gemini-4-neon-high', content: '已后台启动，等待通知。' },
    { step_index: 4, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: iso(4),
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T10:00:04Z sender=system priority=MESSAGE_PRIORITY_LOW content=[Notice] All your subagents and background tasks have been stopped due to server restart.\n</SYSTEM_MESSAGE>' },
    { step_index: 5, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: iso(5),
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T10:00:05Z sender=task-2 priority=MESSAGE_PRIORITY_HIGH content=Background command exited with code 0.\n</SYSTEM_MESSAGE>' },
    { step_index: 6, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(6), model: 'gemini-4-neon-high', content: '后台任务已成功完成。' },
  ];
  const { source, options } = await setup(rows);
  const { plan } = await planImport(source, options);
  assert.equal(plan.counts.users, 1);
  assert.equal(plan.events.filter(e => e.type === 'turn/start').length, 2); // system head + 1 user turn
  const devMessages = plan.preview.filter(m => m.role === 'developer');
  assert.equal(devMessages.length, 1);
  assert.equal(devMessages[0].content[0].text, 'Background command exited with code 0.');
  assert(!JSON.stringify(plan.preview).includes('<SYSTEM_MESSAGE>'));
  assert(!JSON.stringify(plan.preview).includes('server restart'));
  const res = await importSession(source, { ...options, write: true });
  assert.equal(res.status, 'imported');
  assert.equal((await verifySession(res.id, options)).importedPrefixMatches, true);
});

test('agy rejects CHECKPOINT by default and preserves history with --best-effort', async () => {
  const rows = [
    ...fixture(),
    { step_index: 6, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: iso(6), content: '继续下一步' },
    { step_index: 7, source: 'SYSTEM', type: 'CHECKPOINT', status: 'DONE', created_at: iso(7), content: '# Resuming from a compaction\n摘要正文' },
    { step_index: 8, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(8), model: 'gemini-4-neon-high', content: '已基于摘要继续完成。' },
  ];
  const { source, options } = await setup(rows);
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'COMPACTION_UNSUPPORTED' });
  assert(!(await exists(options.targetRoot)));
  const plan = await planImport(source, { ...options, bestEffort: true });
  assert(plan.summary.warnings.some(w => /CHECKPOINT/.test(w)));
  assert(plan.summary.conversions.some(c => /checkpoint/i.test(c.type)));
  assert(plan.plan.preview.some(m => JSON.stringify(m.content).includes('摘要正文')));
  const res = await importSession(source, { ...options, bestEffort: true, write: true });
  assert.equal(res.status, 'imported');
  assert.equal((await verifySession(res.id, options)).importedPrefixMatches, true);
});

test('agy discovery excludes subagents by default, skips empty sessions, blocks active RUNNING sessions, and batches cleanly', async () => {
  const dir = join(root, String(++seq));
  const sourceRoot = join(dir, 'antigravity-cli');
  await mkdir(sourceRoot, { recursive: true });
  const mainId = 'aaaaaaaa-0000-0000-0000-000000000001';
  const subId = 'bbbbbbbb-0000-0000-0000-000000000002';
  const emptyId = 'cccccccc-0000-0000-0000-000000000003';
  const runningId = 'dddddddd-0000-0000-0000-000000000004';
  const mainConv = await writeConv(sourceRoot, mainId, fixture());
  const subConv = await writeConv(sourceRoot, subId, fixture());
  await writeConv(sourceRoot, emptyId, null);
  const runningConv = await writeConv(sourceRoot, runningId, fixture());
  createSummaryDb(sourceRoot, [
    { id: mainId, title: '主会话', stepCount: 6 },
    { id: subId, title: '子代理任务', stepCount: 6, parentId: mainId, nestingDepth: 1 },
    { id: emptyId, title: '', stepCount: 0 },
    { id: runningId, title: '运行中会话', stepCount: 6, status: 'CASCADE_RUN_STATUS_RUNNING', notFullyIdle: true },
  ]);
  const options = { from: 'agy', sourceRoot, targetRoot: join(dir, 'sessions'), dataDir: join(dir, 'data') };

  const listed = await listSessions(options);
  assert.equal(listed.length, 3);
  assert(!listed.some(item => item.id === subId));
  assert.equal(listed.find(item => item.id === emptyId).skipReason !== undefined, true);
  assert.equal(listed.find(item => item.id === runningId).running, true);

  const all = await listSessions({ ...options, includeSubagents: true });
  assert.equal(all.length, 4);
  assert.equal(all.find(item => item.id === subId).kind, 'subagent');
  const subPlan = await planImport(subConv.source, options);
  assert.match(subPlan.summary.title, /^\[Antigravity 子代理\]/);

  await assert.rejects(planImport(runningConv.source, options), { code: 'ACTIVE_SESSION' });
  const bestEffortRunning = await planImport(runningConv.source, { ...options, bestEffort: true });
  assert(bestEffortRunning.summary.warnings.some(w => /运行中/.test(w)));

  const report = await batchImport({ ...options, write: true });
  assert.equal(report.totals.candidates, 3);
  assert.equal(report.totals.imported, 1);
  assert.equal(report.totals.skipped, 1);
  assert.equal(report.totals.failed, 1); // active running session rejected
  assert.equal((await batchImport({ ...options, write: true })).totals.existing, 1);

  const cli = spawnSync(process.execPath, ['bin/sessions2dsh.mjs', 'list', '--from', 'agy', '--source-root', sourceRoot, '--json'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).length, 3);
  assert.equal(mainConv.source, listed.find(item => item.id === mainId).source);
});

test('agy unfinished tool calls require --repair-interrupted, and invalid structure/UTF-8 fails before writes', async () => {
  const { source, options } = await setup(fixture().slice(0, 3)); // 2 tool calls, only 1 GENERIC result
  await assert.rejects(planImport(source, options), { code: 'UNFINISHED_TOOL' });
  const repaired = await importSession(source, { ...options, write: true, repairInterrupted: true });
  assert.equal(repaired.counts.toolResults, 2);
  const saved = JSON.parse(await readFile(join(repaired.backup, 'events.json'), 'utf8'));
  assert.equal(saved.filter(e => e.type === 'tool/result')[1].data.message.isError, true);
  assert.equal(saved.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'interrupted');

  for (const mutate of [
    rows => { rows.push({ step_index: 6, source: 'SYSTEM', type: 'UNKNOWN_STEP', status: 'DONE', created_at: iso(6), content: 'x' }); },
    rows => { rows[2].step_index = 1; }, // non-monotonic step_index
    rows => { rows.splice(1, 1); }, // orphan GENERIC without PLANNER_RESPONSE
  ]) {
    const badRows = fixture(); mutate(badRows);
    const bad = await setup(badRows);
    await assert.rejects(importSession(bad.source, { ...bad.options, write: true }));
    assert(!(await exists(bad.options.targetRoot)));
    assert(!(await exists(bad.options.dataDir)));
  }

  const badUtf8 = await setup();
  const raw = await readFile(badUtf8.source);
  raw[raw.indexOf('file')] = 0xff;
  await writeFile(badUtf8.source, raw);
  await assert.rejects(importSession(badUtf8.source, { ...badUtf8.options, write: true }), { code: 'INVALID_ENCODING' });
  assert(!(await exists(badUtf8.options.dataDir)));
});

test('agy works without summary DB when --cwd is supplied and supports protected system head cold recovery', async () => {
  const { source, options } = await setup(fixture(), { withDb: false });
  await assert.rejects(planImport(source, options), { code: 'SOURCE_CWD' });
  const res = await importSession(source, { ...options, cwd: '/custom/work', write: true });
  assert.equal(res.status, 'imported');
  assert.equal(res.cwd, '/custom/work');
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(res.id, 'read');
    const { events } = await reader.read(), header = reader.header;
    await reader.close();
    const session = runtime.Session.create(res.id, events, header), head = session.surface.nodes[0];
    session.append('turn/start', { turn: 3 }); session.append('step/start', { turn: 3, step: 1 });
    session.append('system/message', { turn: 3, step: 1, message: runtime.createSystemMessage('Updated prompt.') },
      { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] });
    session.append('step/end', { turn: 3, step: 1 }); session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    const writer = await store.open(res.id, 'write');
    try { await writer.append(session.snapshotEvents(events.length)); } finally { await writer.close(); }
  });
  assert.equal((await verifySession(res.id, options)).continued, true);

  const doc = await doctor({ agyRoot: options.sourceRoot });
  assert.equal(doc.agyFound, true);
  assert.equal(doc.agyRoot, options.sourceRoot);
});

test('agy strips injected USER_REQUEST/ADDITIONAL_METADATA/USER_SETTINGS_CHANGE wrappers without truncating nested tags', async () => {
  const rows = fixture();
  rows[0].content = [
    '<USER_REQUEST>',
    '请看这段日志：',
    '<USER_REQUEST>',
    '内层用户原文',
    '</USER_REQUEST>',
    '<ADDITIONAL_METADATA>',
    '用户自己贴的元数据',
    '</ADDITIONAL_METADATA>',
    '结尾说明',
    '</USER_REQUEST>',
    '<ADDITIONAL_METADATA>',
    'The current local time is: 2026-11-20T18:49:45+08:00.',
    '</ADDITIONAL_METADATA>',
    '<USER_SETTINGS_CHANGE>',
    'The user changed setting `Model Selection` from None to Gemini 4 Neon (High).',
    '</USER_SETTINGS_CHANGE>',
  ].join('\n');
  const { source, options } = await setup(rows, { summary: { title: '' } });
  const { plan, summary } = await planImport(source, options);
  const userText = plan.preview.find(m => m.role === 'user').content[0].text;
  assert.equal(userText, '请看这段日志：\n<USER_REQUEST>\n内层用户原文\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n用户自己贴的元数据\n</ADDITIONAL_METADATA>\n结尾说明');
  assert(!userText.includes('2026-11-20T18:49:45'));
  assert(!userText.includes('USER_SETTINGS_CHANGE'));
  assert.match(summary.title, /^\[Antigravity\] 请看这段日志：/);
  assert(summary.conversions.some(c => /USER_REQUEST/.test(c.type)));
});

test('agy skips ERROR_MESSAGE records with warnings and permits older PLANNER_RESPONSE records without model metadata', async () => {
  const rows = fixture().map(r => r.type === 'PLANNER_RESPONSE' ? (({ model, ...rest }) => rest)(r) : r);
  rows.splice(4, 0, {
    step_index: 4, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(4),
    error: 'API error (attempt 1): UNAVAILABLE (code 503): No capacity available',
  });
  rows.push({
    step_index: 7, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(7),
    content: 'Error: Your previous response was blocked by content safety filters.',
    error: 'Your previous response was blocked by content safety filters.',
  });
  // Keep step_index strictly monotonic after splice
  rows.forEach((r, idx) => { r.step_index = idx; r.created_at = iso(idx); });
  const { source, options } = await setup(rows);
  const { plan, summary } = await planImport(source, options);
  assert.equal(summary.counts.assistants, 2);
  assert.equal(plan.skipped.filter(s => s.type === 'ERROR_MESSAGE').length, 2);
  assert(summary.warnings.some(w => /未记录原模型名/.test(w)));
  assert(summary.warnings.some(w => /系统错误/.test(w)));
  const messages = runtime.Session.create(plan.header.id, plan.events, plan.header).deriveMessages();
  const assistant = messages.find(m => m.role === 'assistant');
  assert.equal(assistant.source.provider, 'agy');
  assert.equal(assistant.source.model, 'unknown');
  const res = await importSession(source, { ...options, write: true });
  assert.equal(res.status, 'imported');
  assert.equal((await verifySession(res.id, options)).importedPrefixMatches, true);
});

test('agy accepts raw absolute local media paths inside brain dir and skips empty safety-blocked PLANNER_RESPONSE', async () => {
  const { brainDir, source, options } = await setup();
  const uploadDir = join(brainDir, '.user_uploaded');
  await mkdir(uploadDir, { recursive: true });
  const imgPath = join(uploadDir, 'uploaded.png');
  await writeFile(imgPath, samplePng);
  const rows = fixture();
  rows[0].media = [{ mime_type: 'image/png', uri: imgPath.replaceAll('\\', '/') }];
  rows.splice(5, 0, {
    step_index: 5, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(5),
    input_tokens: 100, cache_read_tokens: 50, output_tokens: 0,
  }, {
    step_index: 6, source: 'SYSTEM', type: 'ERROR_MESSAGE', status: 'DONE', created_at: iso(6),
    content: 'Error: Your previous response was blocked by content safety filters.',
    error: 'Your previous response was blocked by content safety filters.',
  });
  rows.forEach((r, idx) => { r.step_index = idx; r.created_at = iso(idx); });
  await writeFile(source, jsonl(rows));

  const res = await importSession(source, { ...options, write: true });
  assert.equal(res.status, 'imported');
  assert.equal(res.images, 1);
  assert(res.warnings.some(w => /空助手响应/.test(w)));
  const verified = await verifySession(res.id, options);
  assert.equal(verified.imagesVerified, 1);
  assert.equal(verified.importedPrefixMatches, true);

  // Remote URL media must still be rejected.
  const remoteRows = fixture();
  remoteRows[0].media = [{ mime_type: 'image/png', uri: 'https://example.com/a.png' }];
  const remote = await setup(remoteRows);
  await assert.rejects(planImport(remote.source, remote.options), { code: 'EXTERNAL_RESULT' });
});

test('agy subagent starting with SYSTEM_MESSAGE task prompt imports as unwrapped initial user turn', async () => {
  const rows = [
    { step_index: 0, source: 'SYSTEM', type: 'SYSTEM_MESSAGE', status: 'DONE', created_at: iso(0),
      content: 'The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-20T10:00:00Z sender=parent priority=MESSAGE_PRIORITY_HIGH content=请调研仓库结构。\n</SYSTEM_MESSAGE>' },
    { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: iso(1), model: 'gemini-4-neon-high',
      content: '已完成仓库调研。' },
  ];
  const { source, options } = await setup(rows, {
    id: 'eeeeeeee-0000-0000-0000-000000000005',
    summary: { title: '子代理调研', parentId: 'aaaaaaaa-0000-0000-0000-000000000001', nestingDepth: 1, stepCount: 2 },
  });
  const preview = await planImport(source, options);
  assert.equal(preview.plan.preview.find(m => m.role === 'user').content[0].text, '请调研仓库结构。');
  const res = await importSession(source, { ...options, write: true });
  assert.equal(res.status, 'imported');
  assert.match(res.title, /^\[Antigravity 子代理\]/);
  assert(res.conversions.some(c => /subagent initial SYSTEM_MESSAGE/.test(c.type)));
  assert.equal((await verifySession(res.id, options)).importedPrefixMatches, true);
});
