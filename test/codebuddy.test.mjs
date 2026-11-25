import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { planImport, importSession, verifySession, listSessions } from '../src/manager.mjs';
import { batchImport } from '../src/batch.mjs';
import { loadRuntime, withStore, exists } from '../src/runtime.mjs';

let root, runtime, seq = 0;
before(async () => {
  await mkdir(new URL('../tmp/tests/', import.meta.url), { recursive: true });
  root = await mkdtemp(fileURLToPath(new URL('../tmp/tests/codebuddy-', import.meta.url)));
  runtime = await loadRuntime();
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
function fixture(id = 'buddy') {
  const p = { conversationRequestId: 'request1', messageId: 'reply1', stepSeq: 1, model: 'original-model', agent: 'ptc' };
  const base = { sessionId: id, cwd: '/workspace', timestamp: 1790734400000 };
  const rows = [
    { type: 'message', role: 'user', id: 'u1', content: [{ type: 'input_text', text: '请检查' }], providerData: {} },
    { type: 'reasoning', id: 'r1', rawContent: [{ type: 'reasoning_text', text: '检查文件。' }], content: [], providerData: p },
    { type: 'message', role: 'assistant', id: 'a1', status: 'completed', content: [{ type: 'output_text', text: '正在检查。' }], providerData: p },
    { type: 'function_call', id: 'c1', callId: 'call1', name: 'Read', arguments: '{ "path": "a.txt" }', providerData: p },
    { type: 'function_call', id: 'c2', callId: 'call2', name: 'Read', arguments: '{"path":"b.txt"}', providerData: p },
    { type: 'function_call_result', id: 't1', callId: 'call1', name: 'Read', status: 'completed', output: { type: 'text', text: '文件A' }, providerData: {} },
    { type: 'function_call_result', id: 't2', callId: 'call2', name: 'Read', status: 'completed', output: { type: 'text', text: '文件B' }, providerData: { toolResult: { error: true } } },
    { type: 'reasoning', id: 'r2', rawContent: [{ type: 'reasoning_text', text: '已检查。' }], content: [], providerData: { ...p, stepSeq: 2, messageId: 'reply2' } },
    { type: 'message', role: 'assistant', id: 'a2', status: 'completed', content: [{ type: 'output_text', text: '完成。' }], providerData: { ...p, stepSeq: 2, messageId: 'reply2' } },
  ];
  return rows.map((r, i) => ({ ...base, ...r, timestamp: base.timestamp + i, ...(i ? { parentId: rows[i - 1].id } : {}) }));
}
async function setup(rows = fixture()) {
  const dir = join(root, String(++seq)); await mkdir(dir);
  const sourceRoot = join(dir, 'projects'), project = join(sourceRoot, 'example'); await mkdir(project, { recursive: true });
  const source = join(project, 'buddy.jsonl'); await writeFile(source, jsonl(rows));
  return { source, project, options: { from: 'codebuddy', sourceRoot, targetRoot: join(dir, 'sessions'), dataDir: join(dir, 'data') } };
}

test('CodeBuddy preview merges one model step and retains exact arguments, reasoning, and error results', async () => {
  const { source, options } = await setup();
  const a = await planImport(source, { ...options, messages: true }), b = await planImport(source, options);
  assert.deepEqual(a.plan.events, b.plan.events);
  assert.equal(a.summary.sourceKind, 'codebuddy');
  assert.match(a.summary.title, /^\[CodeBuddy\]/);
  assert.deepEqual(a.summary.counts, { users: 1, assistants: 2, toolCalls: 2, toolResults: 2, reasoning: 2 });
  const messages = runtime.Session.create(a.plan.header.id, a.plan.events, a.plan.header).deriveMessages();
  const assistant = messages.find(m => m.role === 'assistant');
  assert.equal(assistant.source.provider, 'codebuddy'); assert.equal(assistant.source.model, 'original-model');
  assert.equal(assistant.content.find(b => b.type === 'tool-call').arguments, '{ "path": "a.txt" }');
  assert.equal(messages.filter(m => m.role === 'tool')[1].isError, true);
  assert(!(await exists(options.targetRoot))); assert(!(await exists(options.dataDir)));
});

test('CodeBuddy native import backs up originals, skips duplicates, preserves continuation, and stays separate from Claude', async () => {
  const { source, options } = await setup(); const original = await readFile(source);
  const result = await importSession(source, { ...options, write: true });
  assert.equal(result.status, 'imported'); assert.deepEqual(await readFile(join(result.backup, 'source.jsonl')), original);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await importSession(source, { ...options, write: true })).status, 'already-imported');
  await withStore(runtime, options.targetRoot, async store => {
    const writer = await store.open(result.id, 'write');
    try { await writer.append([{ seq: result.eventCount, time: 1790734500000, type: 'session/title', data: { title: '续聊', source: { kind: 'user' }, messageSeqs: [] } }]); }
    finally { await writer.close(); }
  });
  const verified = await verifySession(result.id, options); assert.equal(verified.continued, true);
  assert.equal((await importSession(source, { ...options, write: true })).status, 'already-imported');
  const copy = join(options.sourceRoot, 'copy.jsonl'); await copyFile(source, copy);
  assert.equal((await planImport(copy, options)).plan.header.id, result.id);
  await writeFile(source, jsonl(fixture('buddy').map(r => r.id === 'a2' ? { ...r, content: [{ type: 'output_text', text: '改变' }] } : r)));
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'TARGET_CONFLICT' });
});

test('CodeBuddy discovery excludes subagent paths by default and does not mistake mainAgent strings for subagents', async () => {
  const { source, project, options } = await setup([...fixture(), { type: 'session-meta', sessionId: 'buddy', meta: { 'codebuddy.ai/mainAgent': 'ptc' } }]);
  const subdir = join(project, 'buddy', 'subagents'); await mkdir(subdir, { recursive: true });
  await writeFile(join(subdir, 'agent-one.jsonl'), jsonl(fixture('child').map(r => ({ ...r, providerData: { ...r.providerData, isSubAgent: true } }))));
  const main = await listSessions(options); assert.equal(main.length, 1); assert.equal(main[0].source, source); assert.equal(main[0].kind, 'main');
  const all = await listSessions({ ...options, includeSubagents: true }); assert.equal(all.length, 2); assert.equal(all.find(r => r.agentId).kind, 'subagent');
});

test('CodeBuddy batch and CLI dispatch the requested source and report unsupported neighbors', async () => {
  const { project, options } = await setup(); await writeFile(join(project, 'bad.jsonl'), jsonl([...fixture('bad'), { type: 'future-context-op' }]));
  const report = await batchImport({ ...options, write: true });
  assert.equal(report.totals.candidates, 2); assert.equal(report.totals.imported, 1); assert.equal(report.totals.failed, 1);
  assert.equal((await batchImport({ ...options, write: true })).totals.existing, 1);
  const cli = spawnSync(process.execPath, ['bin/sessions2dsh.mjs', 'list', '--from', 'codebuddy', '--source-root', options.sourceRoot, '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).length, 2);
  await assert.rejects(planImport(join(project, 'buddy.jsonl'), { ...options, from: 'wrong' }), { code: 'SOURCE' });
});

test('CodeBuddy external results are fully imported, snapshotted, and checked for changes', async () => {
  const rows = fixture(); const { source, options } = await setup(rows);
  const external = join(source.slice(0, -6), 'tool-results', 'call1.txt'); await mkdir(join(source.slice(0, -6), 'tool-results'), { recursive: true });
  const full = '完整输出\n'.repeat(80); await writeFile(external, full);
  rows[5].output.text = `<persisted-output>\nOutput too large. Full output saved to: ${external}\n\nPreview: 截断\n</persisted-output>`;
  await writeFile(source, jsonl(rows));
  const preview = await planImport(source, options);
  assert.equal(preview.plan.preview.find(m => m.role === 'tool').content[0].text, full);
  assert(!(await exists(options.dataDir)));
  const result = await importSession(source, { ...options, write: true });
  const manifest = JSON.parse(await readFile(join(result.backup, 'manifest.json')));
  assert.equal(manifest.sourceFiles.length, 1); assert.equal(await readFile(join(result.backup, manifest.sourceFiles[0].backup), 'utf8'), full);
  assert.equal((await verifySession(result.id, options)).sourceState, 'unchanged');
  await writeFile(external, '被修改');
  assert.equal((await verifySession(result.id, options)).sourceState, 'changed');
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'TARGET_CONFLICT' });
  await writeFile(join(result.backup, manifest.sourceFiles[0].backup), '备份被篡改');
  await assert.rejects(verifySession(result.id, options), { code: 'BACKUP_CHANGED' });
});

test('CodeBuddy external result path cannot escape its session or silently fall back to a preview', async () => {
  for (const kind of ['missing', 'outside']) {
    const rows = fixture(), { source, options } = await setup(rows);
    const target = kind === 'outside' ? join(root, 'outside.txt') : join(source.slice(0, -6), 'tool-results', 'missing.txt');
    if (kind === 'outside') await writeFile(target, '不可读取');
    rows[5].output.text = `<persisted-output>\nFull output saved to: ${target}\nPreview: 摘录\n</persisted-output>`;
    await writeFile(source, jsonl(rows));
    await assert.rejects(importSession(source, { ...options, write: true }), { code: 'EXTERNAL_RESULT' });
    assert(!(await exists(options.targetRoot))); assert(!(await exists(options.dataDir)));
  }
});

test('CodeBuddy known listing summaries stay outside context, while actual compaction and unknown semantic data fail', async () => {
  const rows = fixture();
  rows.splice(5, 0, { type: 'summary', summary: '目录显示摘要', providerData: { source: 'periodic' } });
  const { source, options } = await setup(rows);
  const plan = await planImport(source, options);
  assert(!JSON.stringify(plan.plan.preview).includes('目录显示摘要')); assert.equal(plan.plan.skipped.length, 1);
  for (const change of [
    r => { r[0].providerData = { isCompacted: true }; },
    r => { r[0].content.push({ type: 'input_image', image_url: 'file:///x' }); },
    r => { r.push({ type: 'future-context-op' }); },
    r => { r[3].sessionId = 'other-id'; },
    r => { r[7].parentId = 'u1'; },
  ]) {
    const changed = fixture(); change(changed); const c = await setup(changed);
    await assert.rejects(importSession(c.source, { ...c.options, write: true }));
    assert(!(await exists(c.options.targetRoot))); assert(!(await exists(c.options.dataDir)));
  }
});

test('CodeBuddy unfinished calls need explicit unknown-outcome recovery and interrupted replies stay interrupted', async () => {
  const rows = fixture().slice(0, 5), { source, options } = await setup(rows);
  await assert.rejects(planImport(source, options), { code: 'UNFINISHED_TOOL' });
  const result = await importSession(source, { ...options, write: true, repairInterrupted: true });
  assert.equal(result.counts.toolResults, 2);
  const saved = JSON.parse(await readFile(join(result.backup, 'events.json')));
  assert.equal(saved.filter(e => e.type === 'tool/result').every(e => e.data.message.isError), true);
  assert.equal(saved.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'interrupted');
  assert.equal((await verifySession(result.id, options)).backupMatches, true);
});

test('CodeBuddy reminder input maps to unwrapped developer message without opening a new human turn', async () => {
  const rows = fixture();
  rows.splice(7, 0,
    { type: 'message', id: 'reminder', parentId: 't2', sessionId: 'buddy', cwd: '/workspace', timestamp: 1790734400007,
      role: 'user', content: [{ type: 'input_text', text: '<system-reminder>任务状态</system-reminder>' }], providerData: { isMeta: true, skipRun: true, taskReminderKind: 'todo', startsNewUserRequest: false } },
    { type: 'message', id: 'retry', parentId: 'reminder', sessionId: 'buddy', cwd: '/workspace', timestamp: 1790734400008,
      role: 'user', content: [{ type: 'input_text', text: '<system-reminder data-role="error-recovery">Network error occurred, please continue</system-reminder>' }], providerData: { isMeta: true, startsNewUserRequest: false } });
  rows[9].parentId = 'retry';
  const { source, options } = await setup(rows);
  const { plan } = await planImport(source, options);
  const devs = plan.preview.filter(m => m.role === 'developer');
  assert.equal(devs.length, 2);
  assert.equal(devs[0].content[0].text, '任务状态');
  assert.equal(devs[1].content[0].text, 'Network error occurred, please continue');
  assert(!JSON.stringify(plan.preview).includes('</system-reminder>'));
  assert.equal(plan.counts.users, 1);
  assert.equal(plan.events.filter(e => e.type === 'turn/start').length, 2);
  const res = await importSession(source, { ...options, write: true });
  assert.equal(res.status, 'imported');
  assert.equal((await verifySession(res.id, options)).importedPrefixMatches, true);
});

test('CodeBuddy reminder arriving between parallel tool results stays in the open step without closing pending calls', async () => {
  const rows = fixture();
  rows.splice(6, 0, {
    type: 'message', id: 'mid-rem', parentId: 't1', sessionId: 'buddy', cwd: '/workspace', timestamp: 1790734400006,
    role: 'user', content: [{ type: 'input_text', text: '<system-reminder>并行工具中间提醒</system-reminder>' }],
    providerData: { isMeta: true, skipRun: true, taskReminderKind: 'task', startsNewUserRequest: false },
  });
  rows[7].parentId = 'mid-rem';
  const { source, options } = await setup(rows);
  const res = await importSession(source, { ...options, write: true });
  assert.equal(res.status, 'imported');
  assert.equal(res.counts.toolCalls, 2);
  assert.equal(res.counts.toolResults, 2);
  assert.equal((await verifySession(res.id, options)).importedPrefixMatches, true);
});

test('CodeBuddy local API errors are disclosed without inventing a model or successful reply', async () => {
  const rows = fixture().slice(0, 1);
  rows.push({ ...rows[0], id: 'error', parentId: 'u1', role: 'assistant', status: 'incomplete', content: [{ type: 'output_text', text: '网络错误' }], providerData: { skipRun: true, error: { code: 'NETWORK' } } });
  const { source, options } = await setup(rows), { plan } = await planImport(source, options);
  assert.equal(plan.counts.assistants, 0);
  assert(plan.warnings.some(w => w.includes('本地错误')));
  assert.equal(plan.events.filter(e => e.type === 'turn/end').at(-1).data.reason.kind, 'interrupted');
});

test('CodeBuddy batch skips command-only, empty, and metadata-only files without creating empty sessions', async () => {
  const { source, project, options } = await setup();
  await writeFile(join(project, 'command.jsonl'), jsonl([{ ...fixture()[0], providerData: { skipRun: true } }]));
  await writeFile(join(project, 'empty.jsonl'), '');
  await writeFile(join(project, 'meta.jsonl'), jsonl([{ type: 'session-meta', sessionId: 'metadata' }]));
  const report = await batchImport({ ...options, write: true });
  assert.equal(report.totals.candidates, 4); assert.equal(report.totals.imported, 1); assert.equal(report.totals.skipped, 3); assert.equal(report.totals.failed, 0);
});

test('CodeBuddy snapshot SHA protects reviewed external bytes even when JSONL is unchanged', async () => {
  const rows = fixture(), { source, options } = await setup(rows);
  const dir = join(source.slice(0, -6), 'tool-results'); await mkdir(dir, { recursive: true }); const path = join(dir, 'call1.txt');
  await writeFile(path, 'original'); rows[5].output.text = `<persisted-output>\nFull output saved to: ${path}\n</persisted-output>`; await writeFile(source, jsonl(rows));
  const { summary } = await planImport(source, options); await writeFile(path, 'changed');
  await assert.rejects(importSession(source, { ...options, write: true, expectSnapshotSha: summary.snapshotSha256 }), { code: 'SOURCE_CHANGED' });
  assert(!(await exists(options.dataDir))); assert(!(await exists(options.targetRoot)));
});

test('CodeBuddy skips never hide unknown records or unknown summary semantics', async () => {
  const { source, project, options } = await setup();
  await writeFile(join(project, 'unknown-only.jsonl'), jsonl([{ type: 'future-context-op' }]));
  await writeFile(join(project, 'unknown-summary.jsonl'), jsonl([{ ...fixture()[0], providerData: { skipRun: true } }, { type: 'summary', summary: 'unknown', providerData: { source: 'future' } }]));
  const report = await batchImport(options);
  assert.equal(report.totals.skipped, 0); assert.equal(report.totals.failed, 2); assert.equal(report.totals.preview, 1);
});

test('CodeBuddy protected system head permits native prompt replacement and cold recovery', async () => {
  const { source, options } = await setup(); const result = await importSession(source, { ...options, write: true });
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(result.id, 'read'); const { events } = await reader.read(), header = reader.header; await reader.close();
    const session = runtime.Session.create(result.id, events, header), head = session.surface.nodes[0];
    session.append('turn/start', { turn: 3 }); session.append('step/start', { turn: 3, step: 1 });
    session.append('system/message', { turn: 3, step: 1, message: runtime.createSystemMessage('Resumed native system prompt.') }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] });
    session.append('step/end', { turn: 3, step: 1 }); session.append('turn/end', { turn: 3, reason: { kind: 'completed' } });
    const writer = await store.open(result.id, 'write'); try { await writer.append(session.snapshotEvents(events.length)); } finally { await writer.close(); }
  });
  assert.equal((await verifySession(result.id, options)).continued, true);
});

test('CodeBuddy legacy compaction envelopes fail before publishing even without provider flags', async () => {
  for (const text of ['<cb_summary>旧摘要</cb_summary>', '<conversation_history_summary>旧摘要</conversation_history_summary>', '<system-reminder data-role="compact-summary">旧摘要</system-reminder>']) {
    const rows = fixture(); rows.push({ ...rows[0], id: 'compact', parentId: 'a2', content: [{ type: 'input_text', text }] });
    const { source, options } = await setup(rows);
    await assert.rejects(importSession(source, { ...options, write: true }), { code: 'COMPACTION_UNSUPPORTED' });
    assert(!(await exists(options.targetRoot))); assert(!(await exists(options.dataDir)));
  }
});

test('CodeBuddy retired history and unknown blocks in secondary reasoning or skipped errors never disappear silently', async () => {
  for (const change of [
    rows => { rows[0].providerData.truncated = true; },
    rows => { rows[2].providerData.discard = true; },
    rows => { rows[1].content = [{ type: 'input_text', text: '检查文件。' }, { type: 'unknown-encrypted' }]; },
    rows => { rows[8].providerData = { skipRun: true, error: {} }; rows[8].status = 'incomplete'; rows[8].content = [{ type: 'future-block' }]; },
  ]) {
    const rows = fixture(); change(rows); const { source, options } = await setup(rows);
    await assert.rejects(importSession(source, { ...options, write: true }));
    assert(!(await exists(options.targetRoot))); assert(!(await exists(options.dataDir)));
  }
});

test('CodeBuddy subagent path conflicting with explicit main flags is rejected', async () => {
  const { project, options } = await setup(); const subdir = join(project, 'buddy', 'subagents'); await mkdir(subdir, { recursive: true });
  const path = join(subdir, 'agent-conflict.jsonl'); await writeFile(path, jsonl(fixture().map(r => ({ ...r, providerData: { ...r.providerData, isSubAgent: false } }))));
  await assert.rejects(planImport(path, options), { code: 'SOURCE_ID' });
});

test('CodeBuddy JSONL with invalid UTF-8 is rejected before any import writes', async () => {
  const rows = fixture(); rows[0].content[0].text = 'before-BAD-after';
  const { source, options } = await setup(rows);
  const bytes = await readFile(source); bytes[bytes.indexOf('BAD')] = 0xff; await writeFile(source, bytes);
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'INVALID_ENCODING' });
  assert(!(await exists(options.dataDir))); assert(!(await exists(options.targetRoot)));
});

test('CodeBuddy best-effort keeps the truncated preview when the external result is unreadable', async () => {
  const rows = fixture(), { source, options } = await setup(rows);
  const missing = join(source.slice(0, -6), 'tool-results', 'missing.txt');
  rows[5].output.text = `<persisted-output>\nFull output saved to: ${missing}\n\nPreview: 摘录\n</persisted-output>`;
  await writeFile(source, jsonl(rows));
  await assert.rejects(planImport(source, options), { code: 'EXTERNAL_RESULT' });
  const plan = await planImport(source, { ...options, bestEffort: true });
  assert.match(plan.plan.preview.find(m => m.role === 'tool').content[0].text, /Preview: 摘录/);
  assert(plan.summary.conversions.some(conversion => /truncated preview kept/.test(conversion.type)));
  assert(plan.summary.warnings.some(warning => /外置结果不可读/.test(warning)));
  const result = await importSession(source, { ...options, bestEffort: true, write: true });
  assert.equal(result.status, 'imported'); assert.equal(result.bestEffort, true);
  assert.equal((await verifySession(result.id, options)).importedPrefixMatches, true);
});

test('CodeBuddy best-effort splits a non-contiguous model step instead of merging it', async () => {
  const rows = fixture();
  rows.push({ ...rows[0], id: 'u2', content: [{ type: 'input_text', text: '再补一点' }] },
    { ...rows[2], id: 'a1b', content: [{ type: 'output_text', text: '补充。' }] });
  rows.forEach((row, index) => { if (index) row.parentId = rows[index - 1].id; else delete row.parentId; });
  const { source, options } = await setup(rows);
  await assert.rejects(planImport(source, options), { code: 'BRANCH_UNSUPPORTED' });
  const plan = await planImport(source, { ...options, bestEffort: true });
  assert(plan.summary.conversions.some(conversion => /non-contiguous model step/.test(conversion.type)));
  assert.equal(plan.summary.counts.assistants, 3);
});

test('CodeBuddy best-effort keeps a compaction envelope as a developer message and retains earlier history', async () => {
  const rows = fixture();
  rows.push({ ...rows[0], id: 'cmp_1', logicalParentId: 'a2',
    content: [{ type: 'input_text', text: '<cb_summary>旧摘要</cb_summary>' }],
    providerData: { compactType: 'pre-message-auto', isCompacted: true, isCompactInternal: true } });
  const { source, options } = await setup(rows);
  await assert.rejects(planImport(source, options), { code: 'COMPACTION_UNSUPPORTED' });
  const plan = await planImport(source, { ...options, bestEffort: true });
  assert(plan.summary.conversions.some(conversion => /compaction envelope/.test(conversion.type)));
  assert(plan.plan.preview.some(message => message.role === 'developer' && JSON.stringify(message.content).includes('旧摘要')));
  assert.deepEqual(plan.summary.counts, { users: 1, assistants: 2, toolCalls: 2, toolResults: 2, reasoning: 2 });
  const result = await importSession(source, { ...options, bestEffort: true, write: true });
  assert.equal(result.status, 'imported');
  assert.equal((await verifySession(result.id, options)).importedPrefixMatches, true);
});

test('CodeBuddy unwraps channel plugin envelopes on user messages without losing text', async () => {
  const rows = fixture();
  rows[0].content = [{ type: 'input_text', text: '<channel source="wechat" chat_id="wechat_123" sender="u1" context_token="abc=="> test一下 </channel>' }];
  const { source, options } = await setup(rows);
  const { plan, summary } = await planImport(source, options);
  const userMsg = plan.preview.find(m => m.role === 'user');
  assert.equal(userMsg.content[0].text, 'test一下');
  assert(!JSON.stringify(plan.preview).includes('</channel>'));
  assert(summary.conversions.some(c => /channel wrapper/.test(c.type)));
  assert.match(summary.title, /^\[CodeBuddy\] test一下$/);
});
