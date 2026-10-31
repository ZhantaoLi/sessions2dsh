import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, rm, stat, chmod, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { transcript, jsonl } from './fixtures.mjs';
import { readSource } from '../src/claude.mjs';
import { convertClaude } from '../src/convert.mjs';
import { defaults, planImport, importSession, verifySession, listSessions } from '../src/manager.mjs';
import { loadRuntime, withStore, withWorkspace, exists } from '../src/runtime.mjs';

let root, runtime, counter = 0;
before(async () => {
  const temporaryRoot = fileURLToPath(new URL('../tmp/tests', import.meta.url));
  await mkdir(temporaryRoot, { recursive: true });
  root = await mkdtemp(join(temporaryRoot, 'run-'));
  runtime = await loadRuntime();
});
after(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function setup(rows) {
  const directory = join(root, `case-${++counter}`);
  await mkdir(directory);
  const source = join(directory, 'source.jsonl');
  await writeFile(source, jsonl(rows || transcript(`fixture-${counter}`)));
  return { source, options: { targetRoot: join(directory, 'sessions'), dataDir: join(directory, 'data') } };
}

test('preview is deterministic and does not create backup or destination files', async () => {
  const { source, options } = await setup();
  const first = await planImport(source, options), second = await planImport(source, options);
  assert.deepEqual(first.plan.events, second.plan.events);
  assert.equal(first.summary.counts.toolCalls, 1);
  assert.equal(first.summary.counts.assistants, 2); // streamed blocks merged
  assert.equal(first.summary.counts.reasoning, 1);
  assert.equal(first.plan.events[0].seq, 0);
  assert(!(await exists(options.targetRoot)));
  assert(!(await exists(options.dataDir)));
  assert.equal((await importSession(source, options)).status, 'preview');
  assert(!(await exists(options.dataDir)));
});

test('workspace sync preserves an existing cwd and registers a new workspace for a new import', async () => {
  const directory = join(root, `workspace-case-${++counter}`);
  const dshHome = join(directory, 'dsh');
  const sourceCwd = join(directory, 'project');
  await mkdir(sourceCwd, { recursive: true });
  const defaultCwd = join(directory, 'default-workspace');
  await mkdir(defaultCwd, { recursive: true });
  const workspaceId = 'default-workspace-id';
  await mkdir(join(dshHome, 'storages'), { recursive: true });
  await writeFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [workspaceId]: { path: defaultCwd, title: 'default-workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } },
  }));
  const rows = transcript('workspace-normal').map(row => ({ ...row, cwd: sourceCwd }));
  const source = join(directory, 'source.jsonl');
  await writeFile(source, jsonl(rows));
  const result = await importSession(source, { write: true, workspaceSync: true, dshHome, targetRoot: join(dshHome, 'sessions'), dataDir: join(directory, 'data') });
  assert.equal(result.cwd, sourceCwd);
  assert.equal(result.workspace.action, 'created-and-attached');
  const registry = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
  assert(registry.tables.workspaces[workspaceId].sessionIds.length === 0);
  const project = Object.values(registry.tables.workspaces).find(item => item.path === sourceCwd);
  assert.deepEqual(project.sessionIds, [result.id]);
});

test('workspace sync rewrites an invalid cwd to the registered default workspace', async () => {
  const directory = join(root, `workspace-fallback-${++counter}`);
  const dshHome = join(directory, 'dsh');
  const defaultCwd = join(directory, 'default-workspace');
  await mkdir(defaultCwd, { recursive: true });
  const workspaceId = 'default-workspace-id';
  await mkdir(join(dshHome, 'storages'), { recursive: true });
  await writeFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [workspaceId]: { path: defaultCwd, title: 'default-workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } },
  }));
  const sourceCwd = join(directory, 'does-not-exist');
  const source = join(directory, 'source.jsonl');
  await writeFile(source, jsonl(transcript('workspace-fallback').map(row => ({ ...row, cwd: sourceCwd }))));
  const options = { workspaceSync: true, dshHome, targetRoot: join(dshHome, 'sessions'), dataDir: join(directory, 'data') };
  const preview = await planImport(source, options);
  assert.equal(preview.plan.header.cwd, defaultCwd);
  assert.equal(preview.summary.originalCwd, sourceCwd);
  const result = await importSession(source, { ...options, write: true });
  assert.equal(result.originalCwd, sourceCwd);
  assert.equal(result.cwd, defaultCwd);
  assert.equal(result.workspace.action, 'fallback-default-and-attach');
  const registry = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
  assert.deepEqual(registry.tables.workspaces[workspaceId].sessionIds, [result.id]);
});

test('workspace sync supplies the default cwd when the source has no cwd field', async () => {
  const directory = join(root, `workspace-missing-cwd-${++counter}`);
  const dshHome = join(directory, 'dsh');
  const defaultCwd = join(directory, 'default-workspace');
  await mkdir(defaultCwd, { recursive: true });
  const workspaceId = 'default-workspace-id';
  await mkdir(join(dshHome, 'storages'), { recursive: true });
  await writeFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [workspaceId]: { path: defaultCwd, title: 'default-workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } },
  }));
  const rows = transcript('workspace-missing-cwd').map(({ cwd, ...row }) => row);
  const source = join(directory, 'source.jsonl');
  await writeFile(source, jsonl(rows));
  const result = await importSession(source, { write: true, workspaceSync: true, dshHome, targetRoot: join(dshHome, 'sessions'), dataDir: join(directory, 'data') });
  assert.equal(result.cwd, defaultCwd);
  assert.equal(result.originalCwd, undefined);
  assert.equal(result.workspace.action, 'fallback-default-and-attach');
});

test('workspace sync leaves previously managed sessions alone', async () => {
  const directory = join(root, `workspace-existing-${++counter}`);
  const sourceCwd = join(directory, 'source-project');
  const defaultCwd = join(directory, 'default-workspace');
  await mkdir(sourceCwd, { recursive: true }); await mkdir(defaultCwd, { recursive: true });
  const source = join(directory, 'source.jsonl');
  await writeFile(source, jsonl(transcript('workspace-existing').map(row => ({ ...row, cwd: sourceCwd }))));
  const dshHome = join(directory, 'dsh');
  const workspaceId = 'default-workspace-id';
  await mkdir(join(dshHome, 'storages'), { recursive: true });
  await writeFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: [workspaceId], archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: { [workspaceId]: { path: defaultCwd, title: 'default-workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } } },
  }));
  const options = { dshHome, targetRoot: join(dshHome, 'sessions'), dataDir: join(directory, 'data') };
  const first = await importSession(source, { ...options, workspaceSync: false, write: true });
  await rm(sourceCwd, { recursive: true, force: true });
  const retry = await importSession(source, { ...options, workspaceSync: true, write: true });
  assert.equal(retry.status, 'already-imported');
  assert.equal(retry.workspace, undefined);
  const registry = JSON.parse(await readFile(join(dshHome, 'storages', 'workspace.json'), 'utf8'));
  assert.deepEqual(registry.tables.workspaces[workspaceId].sessionIds, []);
  assert.equal(first.cwd, sourceCwd);
});

test('native import, byte-identical source backup, repeat after continuation, and verification', async () => {
  const { source, options } = await setup();
  const original = await readFile(source);
  const imported = await importSession(source, { ...options, write: true });
  assert.equal(imported.status, 'imported');
  assert.deepEqual(await readFile(join(imported.backup, 'source.jsonl')), original);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await stat(join(imported.backup, 'source.jsonl'))).mode & 0o777, 0o600);
  assert.equal((await importSession(source, { ...options, write: true })).status, 'already-imported');
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(imported.id, 'read');
    const { events } = await reader.read(); await reader.close();
    const writer = await store.open(imported.id, 'write');
    await writer.append([{ type: 'session/title', seq: events.length, time: Date.now(), data: { title: '用户续聊后改名', source: { kind: 'user' }, messageSeqs: [] } }]);
    await writer.close();
  });
  const repeat = await importSession(source, { ...options, write: true });
  assert.equal(repeat.status, 'already-imported');
  const verified = await verifySession(imported.id, options);
  assert.equal(verified.currentEvents, imported.eventCount + 1);
  assert.equal(verified.continued, true);
  assert.equal((await listSessions({ ...options, from: 'dsh' })).length, 1);
});

test('source growth conflicts instead of overwriting target or backup', async () => {
  const rows = transcript('changed-session');
  const { source, options } = await setup(rows);
  const imported = await importSession(source, { ...options, write: true });
  const backup = await readFile(join(imported.backup, 'source.jsonl'));
  rows.at(-1).message.content[0].text = 'different reply';
  await writeFile(source, jsonl(rows));
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'TARGET_CONFLICT' });
  assert.deepEqual(await readFile(join(imported.backup, 'source.jsonl')), backup);
  const checked = await verifySession(imported.id, options);
  assert.equal(checked.sourceState, 'changed');
  assert.equal(checked.currentEvents, imported.eventCount);
});

test('retry completes an interrupted manifest commit without rewriting the native session', async () => {
  const { source, options } = await setup();
  const imported = await importSession(source, { ...options, write: true });
  const path = join(imported.backup, 'manifest.json');
  const published = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(`${path}.next`, JSON.stringify(published));
  const prepared = { ...published, status: 'prepared' }; delete prepared.publishedAt;
  await writeFile(path, JSON.stringify(prepared));
  const retry = await importSession(source, { ...options, write: true });
  assert.equal(retry.status, 'already-imported');
  assert.equal(JSON.parse(await readFile(path, 'utf8')).status, 'published');
  assert(!(await exists(`${path}.next`)));
  assert.equal((await verifySession(imported.id, options)).currentEvents, imported.eventCount);
});

test('preview SHA guards against changes before apply', async () => {
  const { source, options } = await setup();
  const preview = await planImport(source, options);
  await writeFile(source, (await readFile(source, 'utf8')) + JSON.stringify({ type: 'mode', sessionId: preview.input.sourceSessionId }) + '\n');
  await assert.rejects(importSession(source, { ...options, write: true, expectSha: preview.summary.sourceSha256 }), { code: 'SOURCE_CHANGED' });
  assert(!(await exists(options.targetRoot)));
});

test('malformed images are rejected before any writes', async () => {
  const rows = transcript('image-session'); rows[1].message.content = [{ type: 'image', source: { type: 'base64', data: 'test' } }];
  const { source, options } = await setup(rows);
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'INVALID_IMAGE' });
  assert(!(await exists(options.targetRoot))); assert(!(await exists(options.dataDir)));
});

test('missing tool results are rejected instead of fabricated', async () => {
  const rows = transcript('missing-tool').filter(row => row.uuid !== 'r1');
  const { source, options } = await setup(rows);
  await assert.rejects(planImport(source, options), { code: 'UNFINISHED_TOOL' });
});

test('compaction, sidechain, and human sibling branches fail explicitly', async () => {
  for (const variant of ['compact', 'sidechain', 'branch']) {
    const rows = transcript(variant);
    if (variant === 'compact') rows.push({ type: 'system', subtype: 'compact_boundary', sessionId: variant });
    if (variant === 'sidechain') rows[1].isSidechain = true;
    if (variant === 'branch') {
      rows[1].parentUuid = 'shared-parent';
      rows.push({ ...rows[1], uuid: 'second-branch', timestamp: '2026-10-01T00:01:00.000Z' });
    }
    const { source, options } = await setup(rows);
    await assert.rejects(planImport(source, options), error => ['COMPACTION_UNSUPPORTED', 'BRANCH_UNSUPPORTED'].includes(error.code));
  }
});

test('tool reference fallback is disclosed and text results remain exact', async () => {
  const rows = transcript('tool-reference'); rows[4].message.content[0].content = [{ type: 'tool_reference', tool_name: 'Read' }];
  const { source } = await setup(rows);
  const plan = convertClaude(await readSource(source), runtime);
  assert.equal(plan.conversions[0].type, 'tool_reference → JSON text');
  const result = plan.preview.find(message => message.role === 'tool');
  assert.equal(result.content[0].text, JSON.stringify({ type: 'tool_reference', tool_name: 'Read' }));
});

test('truncated JSONL reports the exact line', async () => {
  const { source } = await setup();
  await writeFile(source, (await readFile(source, 'utf8')) + '{"type":');
  await assert.rejects(readSource(source), error => error.code === 'INVALID_JSONL' && error.message.includes('第 7 行'));
});

test('tampered backups cannot pass verification', async () => {
  const { source, options } = await setup();
  const imported = await importSession(source, { ...options, write: true });
  await writeFile(join(imported.backup, 'events.json'), '[]');
  await assert.rejects(verifySession(imported.id, options), { code: 'BACKUP_CHANGED' });
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'BACKUP_CHANGED' });
});

test('CLI emits machine-readable errors and refuses meaningless write flags', () => {
  const result = spawnSync(process.execPath, ['bin/sessions2dsh.mjs', 'doctor', '--write', '--json'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(JSON.parse(result.stderr).code, 'USAGE');
});

test('session listing reports corrupt files without losing valid neighbors', async () => {
  const folder = join(root, 'claude-projects', 'example'); await mkdir(folder, { recursive: true });
  await writeFile(join(folder, 'valid.jsonl'), jsonl(transcript('listed')));
  await writeFile(join(folder, 'broken.jsonl'), '{');
  const sessions = await listSessions({ claudeRoot: join(root, 'claude-projects') });
  assert.equal(sessions.length, 2); assert.equal(sessions.filter(item => item.error).length, 1);
  assert(sessions.some(item => item.id === 'listed'));
});

test('provider ID reuse across completed tool steps stays separate and deterministic', async () => {
  const rows = transcript('reuse-provider');
  rows.at(-1).message.id = 'stream-1';
  const { source, options } = await setup(rows);
  const imported = await importSession(source, { ...options, write: true });
  assert.equal(imported.counts.assistants, 2);
  assert.equal((await verifySession(imported.id, options)).importedPrefixMatches, true);
});

test('edited queued prompt remains in transcript but supersedes previous model input', async () => {
  const rows = transcript('edit-prompt');
  rows[1].parentUuid = 'same-parent';
  rows.splice(2, 0, { ...rows[1], uuid: 'edited', message: { role: 'user', content: '修改后的提问' } });
  const { source, options } = await setup(rows);
  const imported = await importSession(source, { ...options, write: true });
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(imported.id, 'read');
    const { events } = await reader.read(); await reader.close();
    assert.equal(events.filter(e => e.type === 'user/message' && e.surfaceOp === 'append').length, 2);
    const restored = runtime.Session.create(imported.id, events, reader.header);
    const users = restored.deriveMessages().filter(m => m.role === 'user');
    assert.deepEqual(users.map(m => m.content[0].text), ['修改后的提问']);
  });
});

test('compaction preserves original transcript and replaces only old model context', async () => {
  const rows = transcript('compact-native');
  rows.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: 'compact-native', compactMetadata: { preservedMessages: { allUuids: [] } } });
  rows.push({ ...rows[1], uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true,
    timestamp: '2026-10-01T00:01:00.000Z', message: { role: 'user', content: 'Summary of earlier work.' } });
  const { source, options } = await setup(rows);
  const imported = await importSession(source, { ...options, write: true });
  assert(imported.conversions.some(c => c.type.includes('compact summary')));
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(imported.id, 'read');
    const { events } = await reader.read(); const header = reader.header; await reader.close();
    assert.equal(events.filter(e => e.type === 'assistant/message').length, 2);
    assert.deepEqual(runtime.Session.create(imported.id, events, header).deriveMessages().map(m => m.content[0].text), ['Summary of earlier work.']);
  });
});

test('in-memory image preview has no filesystem effects and native import verifies bytes', async () => {
  const rows = transcript('native-image');
  rows[1].message.content = [{ type: 'text', text: '看图片' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nS8AAAAASUVORK5CYII=' } }];
  const { source, options } = await setup(rows);
  // Generate a fully valid raster with the installed native normalizer's sharp.
  const { createRequire } = await import('node:module');
  const require = createRequire(runtime.packagePath);
  rows[1].message.content[1].source.data = (await require('sharp')({ create: { width: 2, height: 2, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64');
  await writeFile(source, jsonl(rows));
  const preview = await planImport(source, options);
  assert.equal(preview.attachments.size, 1);
  assert(!(await exists(preview.options.attachmentHome)));
  const result = await importSession(source, { ...options, write: true });
  assert.equal((await verifySession(result.id, options)).imagesVerified, 1);
});

test('missing results require explicit recovery and preserve unknown outcome', async () => {
  const rows = transcript('repair-explicit').filter(r => r.uuid !== 'r1');
  const { source, options } = await setup(rows);
  const result = await importSession(source, { ...options, write: true, repairInterrupted: true });
  assert(result.conversions.some(c => c.type.includes('unknown-outcome')));
  assert.equal((await verifySession(result.id, options)).backupMatches, true);
});

test('subagents sharing a parent get distinct identities and workflow paths are discovered', async () => {
  const directory = join(root, 'claude-subagents', 'project', 'parent', 'subagents', 'workflows', 'wf-1');
  await mkdir(directory, { recursive: true });
  const sources = [];
  for (const agentId of ['a1', 'a2']) {
    const source = join(directory, `agent-${agentId}.jsonl`);
    await writeFile(source, jsonl(transcript('shared-parent').map(r => ({ ...r, agentId, isSidechain: true }))));
    sources.push(source);
  }
  const options = { claudeRoot: join(root, 'claude-subagents'), includeSubagents: true, targetRoot: join(root, 'subagent-target') };
  const { includeSubagents, ...defaultOptions } = options;
  assert.equal((await listSessions(defaultOptions)).length, 0);
  assert.equal((await listSessions(options)).length, 2);
  const { batchImport } = await import('../src/batch.mjs');
  assert.equal((await batchImport(defaultOptions)).totals.candidates, 0);
  assert.equal((await batchImport(options)).totals.preview, 2);
  const plans = await Promise.all(sources.map(source => planImport(source, options)));
  assert.notEqual(plans[0].summary.id, plans[1].summary.id);
  assert.equal(plans[0].summary.sourceSessionId, 'shared-parent');
});

test('persisted session can accept a native system prompt update and cold-load again', async () => {
  const { source, options } = await setup();
  const imported = await importSession(source, { ...options, write: true });
  await withStore(runtime, options.targetRoot, async store => {
    const reader = await store.open(imported.id, 'read');
    const { events } = await reader.read(); const header = reader.header; await reader.close();
    const session = runtime.Session.create(imported.id, events, header);
    const head = session.surface.nodes[0];
    const updates = [session.append('turn/start', { turn: 3 }), session.append('step/start', { turn: 3, step: 1 })];
    updates.push(session.append('system/message', { turn: 3, step: 1, message: runtime.createSystemMessage('Native resumed prompt.') }, { surfaceOp: { op: 'replace', startSeq: head, endSeq: head }, sourceEventSeqs: [head] }));
    updates.push(session.append('step/end', { turn: 3, step: 1 }), session.append('turn/end', { turn: 3, reason: { kind: 'completed' } }));
    const writer = await store.open(imported.id, 'write'); await writer.append(session.snapshotEvents(events.length)); await writer.close();
  });
  assert.equal((await verifySession(imported.id, options)).continued, true);
});

test('queued prompts do not prematurely close parallel tool steps', async () => {
  const rows = transcript('queue-prompt');
  rows.splice(4, 0, { ...rows[1], uuid: 'queued', timestamp: '2026-10-01T00:00:02.500Z', message: { role: 'user', content: '补充问题' } });
  const { source, options } = await setup(rows);
  const result = await importSession(source, { ...options, write: true });
  assert(result.conversions.some(c => c.type.includes('queued prompt')));
  assert.equal((await verifySession(result.id, options)).importedPrefixMatches, true);
});

test('reused tool IDs are remapped only after the earlier occurrence completed', async () => {
  const rows = transcript('reuse-tool');
  rows.push({ ...rows[3], uuid: 'a4', timestamp: '2026-10-01T00:00:05.000Z', message: { ...rows[3].message, id: 'new-call' } });
  rows.push({ ...rows[4], uuid: 'r2', timestamp: '2026-10-01T00:00:06.000Z' });
  rows.push({ ...rows[5], uuid: 'a5', timestamp: '2026-10-01T00:00:07.000Z', message: { ...rows[5].message, id: 'last-reply' } });
  const { source, options } = await setup(rows);
  const result = await importSession(source, { ...options, write: true });
  assert.equal(result.counts.toolCalls, 2);
  assert(result.conversions.some(c => c.type.includes('unique occurrence')));
  assert.equal((await verifySession(result.id, options)).importedPrefixMatches, true);
});

test('batch saves partial failures, continues neighbors, and resumes without duplicating', async () => {
  const { batchImport } = await import('../src/batch.mjs');
  const directory = join(root, 'batch-projects', 'project'); await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'good.jsonl'), jsonl(transcript('batch-good')));
  await writeFile(join(directory, 'bad.jsonl'), '{');
  const options = { claudeRoot: join(root, 'batch-projects'), targetRoot: join(root, 'batch-sessions'), dataDir: join(root, 'batch-data'), report: join(root, 'batch-report.json') };
  const preview = await batchImport(options);
  assert.equal(preview.totals.preview, 1); assert.equal(preview.totals.failed, 1);
  assert(!(await exists(options.targetRoot))); assert(!(await exists(options.dataDir)));
  const first = await batchImport({ ...options, write: true });
  assert.equal(first.totals.imported, 1); assert.equal(first.totals.failed, 1);
  assert.equal(JSON.parse(await readFile(options.report)).finishedAt, first.finishedAt);
  await writeFile(join(directory, 'bad.jsonl'), jsonl(transcript('batch-fixed')));
  const retry = await batchImport({ ...options, write: true });
  assert.equal(retry.ok, true); assert.equal(retry.totals.imported, 1); assert.equal(retry.totals.existing, 1);
});

test('managed legacy records resume from verified backups without the original receipt', async () => {
  const { source, options } = await setup();
  const result = await importSession(source, { ...options, write: true });
  const path = join(result.backup, 'manifest.json');
  const manifest = JSON.parse(await readFile(path));
  const legacy = Buffer.from('synthetic immutable legacy artifact');
  const { sha256 } = await import('../src/claude.mjs');
  manifest.legacyArtifact = { source: '/unavailable/old-session.zstd', sha256: sha256(legacy) };
  await writeFile(join(result.backup, 'legacy-original.v4.jsonl.zstd'), legacy);
  await writeFile(path, JSON.stringify(manifest));
  assert.equal((await importSession(source, { ...options, write: true })).status, 'already-imported');
  await writeFile(join(result.backup, 'legacy-original.v4.jsonl.zstd'), 'tampered');
  await assert.rejects(planImport(source, options), { code: 'BACKUP_CHANGED' });
});

test('workspace titles disambiguate with the parent directory name', async () => {
  const { uniqueWorkspaceTitle } = await import('../src/workspace.mjs');
  assert.equal(uniqueWorkspaceTitle('/srv/alpha/crafting', new Set()), 'crafting');
  assert.equal(uniqueWorkspaceTitle('/media/DATA/ProgramData/crafting', new Set(['crafting'])), 'crafting (ProgramData)');
  assert.equal(uniqueWorkspaceTitle('/media/DATA/ProgramData/crafting', new Set(['crafting', 'crafting (ProgramData)'])), 'crafting (DATA)');
  assert.equal(uniqueWorkspaceTitle('/srv/alpha/team/crafting', new Set(['crafting'])), 'crafting (team)');
});

async function workspaceCase(name, sourceCwdParts, extraWorkspaces = []) {
  const directory = join(root, `${name}-${++counter}`);
  const defaultCwd = join(directory, 'default-workspace');
  const sourceCwd = join(directory, ...sourceCwdParts);
  await mkdir(defaultCwd, { recursive: true }); await mkdir(sourceCwd, { recursive: true });
  const source = join(directory, 'source.jsonl');
  await writeFile(source, jsonl(transcript(name).map(row => ({ ...row, cwd: sourceCwd }))));
  const dshHome = join(directory, 'dsh');
  const workspaceId = 'default-workspace-id';
  const tables = { [workspaceId]: { path: defaultCwd, title: 'default-workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() } };
  const ids = [workspaceId];
  for (const [index, item] of extraWorkspaces.entries()) {
    await mkdir(item.path, { recursive: true });
    const id = `other-workspace-id-${index}`;
    tables[id] = { path: item.path, title: item.title, sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    ids.push(id);
  }
  await mkdir(join(dshHome, 'storages'), { recursive: true });
  await writeFile(join(dshHome, 'storages', 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, defaultWorkspaceId: workspaceId, workspaceIds: ids, archivedSessionIds: [], pinnedSessionIds: [] },
    tables: { workspaces: tables },
  }));
  return { directory, sourceCwd, source, options: { write: true, workspaceSync: true, dshHome, targetRoot: join(dshHome, 'sessions'), dataDir: join(directory, 'data') } };
}

test('a new workspace avoids colliding with an existing display title', async () => {
  const directory = join(root, `workspace-duplicate-${++counter}`);
  const other = join(directory, 'elsewhere', 'crafting');
  const { source, options, sourceCwd } = await workspaceCase('workspace-duplicate', ['DATA', 'ProgramData', 'crafting'], [{ path: other, title: 'crafting' }]);
  const result = await importSession(source, { ...options, _appRunning: false });
  assert.equal(result.workspace.action, 'created-and-attached');
  assert.equal(result.workspace.workspaceTitle, 'crafting (ProgramData)');
  const registry = JSON.parse(await readFile(join(options.dshHome, 'storages', 'workspace.json'), 'utf8'));
  const titles = Object.values(registry.tables.workspaces).map(item => item.title);
  assert.equal(new Set(titles).size, titles.length);
  assert.equal(Object.values(registry.tables.workspaces).find(item => item.path === sourceCwd).title, 'crafting (ProgramData)');
});

test('workspace registration asks the user to restart a running local app', async () => {
  const running = await workspaceCase('workspace-restart-running', ['project']);
  const warned = await importSession(running.source, { ...running.options, _appRunning: true });
  assert(warned.warnings.some(warning => warning.includes('请重启 DeepSeek Harness 应用')));

  const idle = await workspaceCase('workspace-restart-idle', ['project']);
  const quiet = await importSession(idle.source, { ...idle.options, _appRunning: false });
  assert.equal(quiet.workspace.action, 'created-and-attached');
  assert(!(quiet.warnings || []).some(warning => warning.includes('请重启')));
});

test('pinning preserves imported workspace membership when the app holds an older registry', async () => {
  const { source, options, sourceCwd } = await workspaceCase('pin-stale-app', ['project']);
  const planned = await planImport(source, options);
  await withWorkspace(runtime, defaults(options), async staleRegistry => {
    const rpc = async (method, args) => {
      if (method === 'session/projections') return { kind: 'sequenced', asOfSeq: planned.plan.events.length - 1, values: {} };
      if (method === 'session/page') return { records: planned.plan.events.map(event => ({ type: 'event', event })), hasMore: false };
      if (method === 'session/list') return { items: [{ sessionId: planned.summary.id }] };
      if (method === 'workspace/pinSession') return staleRegistry.pinSession(args.request.sessionId);
      throw new Error(`Unexpected RPC: ${method}`);
    };
    const result = await importSession(source, { ...options, pin: true, _rpc: rpc, _appRunning: true });
    const registry = JSON.parse(await readFile(join(options.dshHome, 'storages', 'workspace.json')));
    assert.deepEqual(Object.values(registry.tables.workspaces).find(w => w.path === sourceCwd)?.sessionIds, [result.id]);
    assert.deepEqual(registry.global.pinnedSessionIds, [result.id]);
    assert.equal(result.application.historyMatches, true);
  });
});

test('workspace failures return a nonzero CLI exit and can retry without rewriting history', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const { source, options } = await workspaceCase('workspace-failed-cli', ['project']);
  const storage = join(options.dshHome, 'storages');
  await chmod(storage, 0o500);
  try {
    const cli = spawnSync(process.execPath, ['bin/sessions2dsh.mjs', 'import', source,
      '--dsh-home', options.dshHome, '--data-dir', options.dataDir, '--write'], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
    assert.equal(cli.status, 1, cli.stdout);
    assert.match(cli.stderr, /工作区.*失败/);
    const listed = await listSessions({ ...options, from: 'dsh' });
    assert.equal(listed.length, 1);
    assert.equal((await verifySession(listed[0].id, options)).importedPrefixMatches, true);
  } finally { await chmod(storage, 0o700); }
  const retry = await importSession(source, { ...options, _appRunning: false });
  assert.equal(retry.status, 'already-imported');
  assert.equal(retry.workspace.ok, true);
});

test('batch reports workspace failures separately from successfully imported history', {
  skip: process.platform === 'win32' || process.getuid?.() === 0,
}, async () => {
  const { batchImport } = await import('../src/batch.mjs');
  const { source, options, directory } = await workspaceCase('workspace-failed-batch', ['project']);
  const claudeRoot = join(directory, 'projects'); await mkdir(join(claudeRoot, 'example'), { recursive: true });
  await writeFile(join(claudeRoot, 'example', 'source.jsonl'), await readFile(source));
  const storage = join(options.dshHome, 'storages'); await chmod(storage, 0o500);
  try {
    const report = await batchImport({ ...options, claudeRoot, _appRunning: false });
    assert.equal(report.ok, false);
    assert.equal(report.totals.imported, 1);
    assert.equal(report.totals.workspaceFailed, 1);
    assert.equal(report.results[0].verification.importedPrefixMatches, true);
  } finally { await chmod(storage, 0o700); }
  const retried = await batchImport({ ...options, claudeRoot, _appRunning: true });
  assert.equal(retried.ok, true);
  assert.equal(retried.totals.existing, 1);
  assert.equal(retried.totals.imported, 0);
  assert.equal(retried.warnings?.length, 1);
});

test('reimport refuses an explicit cwd change without modifying the target', async () => {
  const { source, options, directory } = await workspaceCase('cwd-conflict', ['project']);
  const first = await importSession(source, { ...options, _appRunning: false });
  const other = join(directory, 'other'); await mkdir(other);
  await assert.rejects(importSession(source, { ...options, cwd: other }), { code: 'TARGET_CONFLICT' });
  assert.equal((await verifySession(first.id, options)).currentEvents, first.eventCount);
});

test('managed fallback sessions can repeat after the default workspace directory disappears', async () => {
  const { source, options, sourceCwd, directory } = await workspaceCase('old-default-missing', ['project']);
  await rm(sourceCwd, { recursive: true });
  const first = await importSession(source, { ...options, _appRunning: false });
  await rm(join(directory, 'default-workspace'), { recursive: true });
  const repeat = await importSession(source, { ...options, _appRunning: false });
  assert.equal(repeat.status, 'already-imported');
  assert.equal(repeat.cwd, first.cwd);
  assert.equal(repeat.workspace.status, 'attached');
});

test('isolated imports and already attached repeats do not request an unnecessary restart', async () => {
  const { source, options } = await setup();
  const isolated = await importSession(source, { ...options, write: true, _appRunning: true });
  assert(!(isolated.warnings || []).some(w => w.includes('请重启')));
  const grouped = await workspaceCase('repeat-no-restart', ['project']);
  await importSession(grouped.source, { ...grouped.options, _appRunning: false });
  const repeat = await importSession(grouped.source, { ...grouped.options, _appRunning: true });
  assert(!(repeat.warnings || []).some(w => w.includes('请重启')));
});

test('default backups remain inside the tool directory when its path contains spaces and unicode', async () => {
  const directory = join(root, 'tool space 中文');
  await cp(new URL('../src', import.meta.url), join(directory, 'src'), { recursive: true });
  const copied = await import(pathToFileURL(join(directory, 'src', 'manager.mjs')));
  assert.equal(copied.defaults().dataDir, join(directory, 'data'));
});

test('Claude JSONL with invalid UTF-8 is rejected before any import writes', async () => {
  const rows = transcript('invalid-encoding'); rows[1].message.content = 'before-BAD-after';
  const { source, options } = await setup(rows);
  const bytes = await readFile(source); bytes[bytes.indexOf('BAD')] = 0xff; await writeFile(source, bytes);
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'INVALID_ENCODING' });
  assert(!(await exists(options.dataDir))); assert(!(await exists(options.targetRoot)));
});

test('Claude compaction rejects missing, invalid, or unmappable preserved message UUIDs', async () => {
  for (const preservedMessages of [{}, { allUuids: 'u1' }, { allUuids: ['unknown'] }, { allUuids: [null] }]) {
    const rows = transcript('bad-compaction');
    rows.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: 'bad-compaction', compactMetadata: { preservedMessages } });
    rows.push({ ...rows[1], uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true, timestamp: '2026-10-01T00:01:00.000Z', message: { role: 'user', content: 'Summary' } });
    const { source, options } = await setup(rows);
    await assert.rejects(importSession(source, { ...options, write: true }), { code: 'COMPACTION_UNSUPPORTED' });
    assert(!(await exists(options.targetRoot)));
  }
});

test('Claude compaction permits known skipped metadata in its preserved UUID list', async () => {
  const rows = transcript('compact-with-metadata');
  rows.push({ type: 'system', subtype: 'turn_duration', uuid: 'duration', sessionId: 'compact-with-metadata' });
  rows.push({ ...rows[1], uuid: 'local', message: { role: 'user', content: '<local-command-stdout>done</local-command-stdout>' } });
  rows.push({ ...rows[1], uuid: 'meta', isMeta: true });
  rows.push({ type: 'system', subtype: 'compact_boundary', uuid: 'boundary', sessionId: 'compact-with-metadata',
    compactMetadata: { preservedMessages: { allUuids: ['a3', 'duration', 'local', 'meta'] } } });
  rows.push({ ...rows[1], uuid: 'summary', parentUuid: 'boundary', isCompactSummary: true,
    timestamp: '2026-10-01T00:01:00.000Z', message: { role: 'user', content: 'Summary' } });
  const { source, options } = await setup(rows);
  const { plan } = await planImport(source, options);
  assert.deepEqual(plan.preview.map(m => m.content[0].text), ['Summary', '文件内容是 Hello, session bridge!']);
});

test('unfinished duplicate Claude tool IDs are rejected even with interrupted recovery enabled', async () => {
  const rows = transcript('duplicate-open-call');
  rows[3].message.content.push({ type: 'tool_use', id: 'call-1', name: 'Write', input: { path: 'other.txt', content: 'second call' } });
  const { source, options } = await setup(rows);
  await assert.rejects(importSession(source, { ...options, write: true, repairInterrupted: true }), { code: 'DUPLICATE_CALL' });
  assert(!(await exists(options.targetRoot)));
});

test('unfinished Claude tool IDs cannot be reused across assistant steps during recovery', async () => {
  const rows = transcript('duplicate-across-steps');
  rows.splice(4, 0, { ...rows[3], uuid: 'second-call', message: { ...rows[3].message, id: 'second-step',
    content: [{ type: 'tool_use', id: 'call-1', name: 'Write', input: { path: 'other.txt', content: 'second call' } }] } });
  const { source, options } = await setup(rows);
  await assert.rejects(importSession(source, { ...options, write: true, repairInterrupted: true }), { code: 'DUPLICATE_CALL' });
  assert(!(await exists(options.targetRoot)));
});

test('duplicate dialogue UUIDs cannot masquerade as metadata after compaction', async () => {
  const rows = transcript('duplicate-compaction');
  rows.push(structuredClone(rows[1]));
  for (const [index, uuids] of [[], ['u1']].entries()) {
    const boundary = `boundary-${index}`;
    rows.push({ type: 'system', subtype: 'compact_boundary', uuid: boundary, sessionId: 'duplicate-compaction',
      compactMetadata: { preservedMessages: { allUuids: uuids } } });
    rows.push({ ...rows[1], uuid: `summary-${index}`, parentUuid: boundary, isCompactSummary: true,
      timestamp: `2026-10-01T00:01:0${index}.000Z`, message: { role: 'user', content: `Summary ${index}` } });
  }
  const { source, options } = await setup(rows);
  await assert.rejects(importSession(source, { ...options, write: true }), { code: 'COMPACTION_UNSUPPORTED' });
  assert(!(await exists(options.targetRoot)));
});
