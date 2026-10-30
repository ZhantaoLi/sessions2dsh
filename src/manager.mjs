import { readFile, mkdir, open, unlink, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './claude.mjs';
import { loadRuntime, findRuntime, withStore, exists } from './runtime.mjs';
import { check, ToolError, errorInfo } from './errors.mjs';
import { connectApp, inspectApp, appIsRunning } from './app.mjs';
import { prepareAttachments, publishAttachments, verifyAttachments } from './attachments.mjs';
import { recoverLegacy } from './legacy.mjs';
import { sourceAdapter } from './sources.mjs';
import { snapshotDigest, checkSnapshot, backupFilePath, verifyFileBackups, sourceFilesState } from './snapshot.mjs';
import { resolveWorkspaceCwd, syncWorkspace, workspaceOptions } from './workspace.mjs';

export const APP_RESTART_HINT = '请重启 DeepSeek Harness 应用';

export function defaults(options = {}) {
  const dshHome = resolve(options.dshHome || process.env.DSH_HOME || join(homedir(), '.dsh'));
  return {
    ...options,
    claudeRoot: resolve(options.claudeRoot || join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects')),
    codebuddyRoot: resolve(options.codebuddyRoot || join(homedir(), '.codebuddy', 'projects')),
    dshHome, targetRoot: resolve(options.targetRoot || join(dshHome, 'sessions')),
    attachmentHome: resolve(options.attachmentHome || (options.targetRoot ? join(resolve(options.targetRoot), '..', 'attachment-home') : dshHome)),
    workspaceStorageRoot: resolve(options.workspaceStorageRoot || join(dshHome, 'storages')),
    workspaceSync: options.workspaceSync ?? !options.targetRoot,
    dataDir: resolve(options.dataDir || new URL('../data', import.meta.url).pathname),
    appLog: resolve(options.appLog || join(dshHome, 'web-launcher.log')),
  };
}
function recordPath(options, id) {
  check(/^session-[a-f0-9-]{36}$/.test(id), 'SESSION_ID', '会话 ID 格式无效。');
  return join(options.dataDir, 'imports', sha256(options.targetRoot).slice(0, 12), id);
}
async function writeExclusive(path, bytes) {
  const handle = await open(path, 'wx', 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}
async function writeAtomic(path, object) {
  const temporary = `${path}.next`;
  try { await writeExclusive(temporary, JSON.stringify(object, null, 2) + '\n'); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    // Finish our own interrupted receipt commit only when every stable field
    // matches. A stale .next can never replace unrelated import metadata.
    let pending;
    try { pending = JSON.parse(await readFile(temporary, 'utf8')); }
    catch { throw new ToolError('MANIFEST_PENDING', `未完成的清单写入需要检查：${temporary}`); }
    check(isDeepStrictEqual({ ...pending, publishedAt: null }, { ...object, publishedAt: null }),
      'MANIFEST_PENDING', `未完成的清单与本次导入不同，请检查：${temporary}`);
  }
  await rename(temporary, path);
}
async function readStored(store, id) {
  const snapshot = (await store.list()).find(item => item.header.id === id);
  if (!snapshot) return null;
  check(snapshot.formatStatus !== 'migration-required', 'TARGET_FORMAT', '目标会话需要格式迁移；工具不会自动迁移现有数据。');
  const handle = await store.open(id, 'read');
  try { return { header: handle.header, ...(await handle.read()) }; }
  finally { await handle.close(); }
}
const targetStore = (runtime, options, callback) => options._store ? callback(options._store) : withStore(runtime, options.targetRoot, callback);
function matchesPrefix(stored, plan) {
  check(isDeepStrictEqual(stored.header, plan.header) && isDeepStrictEqual(stored.events.slice(0, plan.events.length), plan.events),
    'TARGET_CONFLICT', '目标 ID 已存在，但历史前缀不同。源会话可能已增长、选项不同或数据已被修改；未覆盖任何目标记录。');
}
function publicPlan(input, plan, options, duplicate) {
  return { source: input.source, sourceKind: input.sourceKind || 'claude', sourceSessionId: input.sourceSessionId, agentId: input.agentId, sourceSha256: input.sourceSha256,
    id: plan.header.id, title: plan.title, cwd: plan.header.cwd, ...(plan.workspace ? { originalCwd: plan.workspace.sourceCwd, workspace: plan.workspace } : {}), targetRoot: options.targetRoot,
    dshVersion: options.dshVersion, duplicate, eventCount: plan.events.length, counts: plan.counts,
    skippedRows: plan.skipped.length, conversions: plan.conversions, warnings: plan.warnings,
    limitations: plan.limitations, ...(options.messages ? { messages: plan.preview } : {}) };
}

export async function planImport(path, supplied = {}) {
  const options = defaults(supplied);
  const adapter = sourceAdapter(options);
  check(!options.reuseReceipt || adapter.kind === 'claude', 'REUSE_RECEIPT', '--reuse-receipt 仅适用于旧 Claude 试验。');
  const input = await adapter.read(path);
  if (options.expectSha) check(input.sourceSha256 === options.expectSha, 'SOURCE_CHANGED', '源文件已变化，与 --expect-sha 不匹配。');
  const runtime = await loadRuntime(options.runtime);
  const attachments = await prepareAttachments(input, runtime);
  const sourceCwd = options.cwd || input.rows?.find(row => row.cwd)?.cwd || input.records?.find(row => row.cwd)?.cwd;
  const workspacePlan = await resolveWorkspaceCwd(sourceCwd, workspaceOptions(options));
  const plan = await adapter.convert(input, runtime, { ...options, ...(workspacePlan.cwd ? { cwd: workspacePlan.cwd } : {}), attachments });
  const managedManifestPath = join(recordPath(options, plan.header.id), 'manifest.json');
  if (await exists(managedManifestPath)) {
    const managed = JSON.parse(await readFile(managedManifestPath, 'utf8'));
    plan.header = managed.header;
    if (managed.workspace) plan.workspace = managed.workspace;
  } else if (workspacePlan.workspace) {
    plan.workspace = workspacePlan.workspace;
    if (workspacePlan.warning) plan.warnings.push(workspacePlan.warning);
  }
  runtime.Session.create(plan.header.id, plan.events, plan.header);
  const sourceFiles = (input.files || []).map(({ bytes, ...file }) => file);
  if (options.expectSnapshotSha) check(snapshotDigest(input) === options.expectSnapshotSha, 'SOURCE_CHANGED', '来源 JSONL 或外置结果与审阅的完整快照 SHA 不一致。');
  let duplicate = false;
  let managedLegacy = false;
  const existingRecord = recordPath(options, plan.header.id);
  if (await exists(join(existingRecord, 'manifest.json'))) {
    const manifest = JSON.parse(await readFile(join(existingRecord, 'manifest.json'), 'utf8'));
    if (manifest.legacyArtifact) {
      check(manifest.sourceSha256 === input.sourceSha256 && manifest.targetRoot === options.targetRoot && manifest.header.cwd === plan.header.cwd &&
        (!options.title || options.title === manifest.title), 'SOURCE_CHANGED', '已登记旧会话的来源或导入选项已变化。');
      const backup = await readFile(join(existingRecord, 'events.json'));
      check(sha256(backup) === manifest.eventsSha256 && sha256(await readFile(join(existingRecord, 'source.jsonl'))) === input.sourceSha256 &&
        sha256(await readFile(join(existingRecord, 'legacy-original.v4.jsonl.zstd'))) === manifest.legacyArtifact.sha256, 'BACKUP_CHANGED', '已登记旧会话的备份校验失败。');
      plan.events = JSON.parse(backup); plan.header = manifest.header; plan.title = manifest.title;
      plan.mapping = manifest.mapping; plan.conversions = manifest.conversions; plan.legacyArtifact = manifest.legacyArtifact;
      runtime.Session.create(plan.header.id, plan.events, plan.header);
      managedLegacy = true;
    }
  }
  if (options.reuseReceipt && !managedLegacy) {
    const receipt = JSON.parse(await readFile(options.reuseReceipt, 'utf8'));
    if (!input.agentId && receipt.sourceSessionId === input.sourceSessionId) {
      check(receipt.sourceSha256 === input.sourceSha256 && receipt.root === options.targetRoot, 'REUSE_RECEIPT', '旧导入凭据的来源 SHA 或目标根目录不匹配。');
      let stored;
      try { stored = await targetStore(runtime, options, store => readStored(store, receipt.id)); }
      catch (error) {
        check(error.message.includes('system/message requires a protected first surface head'), 'REUSE_CONFLICT', '旧会话读取失败，且不是已验证的系统头问题。');
        await recoverLegacy(receipt, plan, runtime, options.targetRoot);
      }
      if (!plan.legacyBackup) {
      check(stored && Number.isSafeInteger(receipt.events) && receipt.events > 0, 'REUSE_RECEIPT', '旧凭据对应目标不存在或事件数无效。');
      const prefix = stored.events.slice(0, receipt.events);
      const previous = runtime.Session.create(receipt.id, prefix, stored.header);
      const generated = runtime.Session.create(plan.header.id, plan.events, plan.header);
      const payloads = session => session.deriveMessages().filter(m => m.role !== 'system').map(({ role, content }) => ({ role, content }));
      check(stored.header.cwd === plan.header.cwd && stored.header.createdAt === plan.header.createdAt && isDeepStrictEqual(payloads(previous), payloads(generated)),
        'REUSE_CONFLICT', '旧目标的原始消息、工具参数/结果或时间边界不匹配，拒绝登记。');
      plan.header = stored.header; plan.events = prefix; plan.title = receipt.title;
      plan.conversions.push({ type: 'verified legacy receipt → preserve existing native prefix and continuation', receipt: resolve(options.reuseReceipt) });
      }
    }
  }
  if (await exists(options.targetRoot)) await targetStore(runtime, options, async store => {
    const stored = await readStored(store, plan.header.id);
    if (stored) { matchesPrefix(stored, plan); duplicate = true; }
  });
  return { input, runtime, plan, options, attachments, summary: { ...publicPlan(input, plan, { ...options, dshVersion: runtime.version }, duplicate), images: attachments.size,
    ...(adapter.kind === 'codebuddy' ? { sourceFiles, snapshotSha256: snapshotDigest(input) } : {}),
    ...(plan.legacyBackup || plan.legacyArtifact ? { legacyArtifact: plan.legacyArtifact || { source: plan.legacyBackup.path, sha256: plan.legacyBackup.sha256 } } : {}) } };
}

export async function importSession(path, supplied = {}) {
  const prepared = await planImport(path, supplied);
  const { input, runtime, plan, options, summary, attachments } = prepared;
  if (!options.write) return { status: 'preview', ...summary, hint: '未写入任何文件。添加 --write 执行导入。' };
  const directory = recordPath(options, plan.header.id);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = join(directory, 'import.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new ToolError('IMPORT_LOCKED', `有导入正在执行，或上次运行被中断：${lockPath}。先核对锁内 PID，确认进程已结束后再移除该锁。`); throw error; }
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    const manifestPath = join(directory, 'manifest.json');
    if (plan.legacyBackup) {
      const old = plan.legacyBackup, path = join(directory, 'legacy-original.v4.jsonl.zstd');
      check(sha256(await readFile(old.path)) === old.sha256, 'SOURCE_CHANGED', '旧会话在导入前发生变化。');
      if (await exists(path)) check(sha256(await readFile(path)) === old.sha256, 'BACKUP_CONFLICT', '旧会话备份已变化。');
      else await writeExclusive(path, old.bytes);
    }
    let manifest;
    if (await exists(manifestPath)) {
      manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
      check(manifest.sourceSha256 === input.sourceSha256 && manifest.eventsSha256 === sha256(JSON.stringify(plan.events)),
        'SOURCE_CHANGED', '同一会话已有不同的导入记录。拒绝覆盖备份或重新导入增长后的源会话。');
      check(sha256(await readFile(join(directory, 'source.jsonl'))) === manifest.sourceSha256 &&
        sha256(await readFile(join(directory, 'events.json'))) === manifest.eventsSha256,
      'BACKUP_CHANGED', '已有来源备份或转换事件校验失败，请先检查备份。');
      await verifyFileBackups(directory, manifest.sourceFiles);
    } else {
      // A previous interrupted backup write can be reused only when identical.
      for (const [name, bytes] of [['source.jsonl', input.bytes], ['events.json', Buffer.from(JSON.stringify(plan.events))]]) {
        const target = join(directory, name);
        if (await exists(target)) check((await readFile(target)).equals(bytes), 'BACKUP_CONFLICT', `备份不同：${target}`);
        else await writeExclusive(target, bytes);
      }
      for (const file of input.files || []) {
        const target = backupFilePath(directory, file.backup);
        await mkdir(join(directory, 'external'), { recursive: true, mode: 0o700 });
        if (await exists(target)) check(sha256(await readFile(target)) === file.sha256, 'BACKUP_CONFLICT', '外置结果已有不同备份。');
        else await writeExclusive(target, file.bytes);
      }
      manifest = { schemaVersion: 1, adapterVersion: 2, status: 'prepared', createdAt: new Date().toISOString(),
        ...summary, attachmentHome: options.attachmentHome, header: plan.header, eventsSha256: sha256(JSON.stringify(plan.events)), mapping: plan.mapping, skipped: plan.skipped };
      if (plan.workspace) manifest.workspace = { ...plan.workspace, status: 'pending' };
      await writeExclusive(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
    }
    // Source changing during conversion must not create a stale snapshot import.
    await checkSnapshot(input);
    await publishAttachments(attachments, runtime, options.attachmentHome);
    let alreadyPresent = false;
    await targetStore(runtime, options, async store => {
      const stored = await readStored(store, plan.header.id);
      if (stored) { matchesPrefix(stored, plan); alreadyPresent = true; return; }
      const writer = await store.create(plan.header);
      try { await writer.append(plan.events); await writer.flush(); } finally { await writer.close(); }
      const published = await readStored(store, plan.header.id);
      check(published, 'PUBLISH_FAILED', '写入后未发现目标会话；请保留备份和诊断记录。');
      matchesPrefix(published, plan);
    });
    manifest.status = 'published'; manifest.publishedAt ||= new Date().toISOString();
    if (summary.legacyArtifact) manifest.legacyArtifact = summary.legacyArtifact;
    let workspaceResult = null;
    if (manifest.workspace && manifest.workspace.status !== 'attached') {
      try {
        workspaceResult = await syncWorkspace(plan.workspace ? plan : { ...plan, workspace: manifest.workspace }, options, runtime);
        if (workspaceResult) manifest.workspace = { ...workspaceResult, status: 'attached' };
      } catch (error) {
        manifest.workspace = { ...manifest.workspace, status: 'failed', error: error.message };
        workspaceResult = { ...manifest.workspace, ok: false };
      }
    }
    await writeAtomic(manifestPath, manifest);
    const result = { status: alreadyPresent ? 'already-imported' : 'imported', ...summary, duplicate: alreadyPresent, backup: directory };
    if (workspaceResult) result.workspace = workspaceResult;
    if (workspaceResult?.ok !== false && !options._suppressAppRestartHint &&
      (options._appRunning === undefined ? await appIsRunning(options.appLog) : options._appRunning)) {
      result.warnings = [...(result.warnings || []), APP_RESTART_HINT];
    }
    if (options.app || options.pin) {
      try {
        const rpc = options._rpc || await connectApp(options.appLog);
        result.application = await inspectApp(rpc, plan.header.id, plan.events);
        if (options.pin) { await rpc('workspace/pinSession', { request: { sessionId: plan.header.id } }); result.application.pinned = true; }
      } catch (error) { result.application = { ok: false, ...errorInfo(error), hint: '原生会话已导入；应用验证失败不回滚历史。' }; }
    }
    return result;
  } finally { await lock.close(); await unlink(lockPath); }
}

export async function verifySession(id, supplied = {}) {
  const options = defaults(supplied);
  const directory = recordPath(options, id);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') throw new ToolError('NOT_MANAGED', '没有该会话的导入记录；请核对 --target-root 和 --data-dir。'); throw error; }
  check(manifest.id === id && manifest.targetRoot === options.targetRoot, 'MANIFEST', '导入记录的 ID 或目标路径不匹配。');
  const source = await readFile(join(directory, 'source.jsonl'));
  const eventsText = await readFile(join(directory, 'events.json'), 'utf8');
  check(sha256(source) === manifest.sourceSha256 && sha256(eventsText) === manifest.eventsSha256, 'BACKUP_CHANGED', '来源备份或转换事件校验失败。');
  await verifyFileBackups(directory, manifest.sourceFiles);
  if (manifest.legacyArtifact) check(sha256(await readFile(join(directory, 'legacy-original.v4.jsonl.zstd'))) === manifest.legacyArtifact.sha256,
    'BACKUP_CHANGED', '旧原生会话备份校验失败。');
  const events = JSON.parse(eventsText);
  const runtime = await loadRuntime(options.runtime);
  const plan = { header: manifest.header, events };
  const stored = await targetStore(runtime, options, store => readStored(store, id));
  check(stored, 'TARGET_MISSING', '目标会话不存在。'); matchesPrefix(stored, plan);
  runtime.Session.create(id, events, manifest.header);
  const imagesVerified = await verifyAttachments(events, runtime, manifest.attachmentHome || options.attachmentHome);
  let sourceState = 'missing';
  try { sourceState = sha256(await readFile(manifest.source)) === manifest.sourceSha256 ? 'unchanged' : 'changed'; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const externalState = await sourceFilesState(manifest.sourceFiles);
  if (sourceState !== 'changed' && externalState !== 'unchanged') sourceState = externalState;
  const result = { status: 'verified', id, title: manifest.title, importedEvents: events.length, currentEvents: stored.events.length,
    sourceState, backupMatches: true, imagesVerified, importedPrefixMatches: true, continued: stored.events.length > events.length, backup: directory };
  if (options.app) result.application = await inspectApp(await connectApp(options.appLog), id, events);
  return result;
}

export async function listSessions(supplied = {}) {
  const options = defaults(supplied);
  const source = options.from || 'claude';
  if (source !== 'dsh') { const adapter = sourceAdapter(options); return adapter.list(adapter.root, options); }
  if (!(await exists(options.targetRoot))) return [];
  const runtime = await loadRuntime(options.runtime);
  return withStore(runtime, options.targetRoot, async store => (await store.list()).map(item => ({
    id: item.header.id, cwd: item.header.cwd, createdAt: new Date(item.header.createdAt).toISOString(), format: item.formatStatus, bytes: item.sizeBytes,
  })));
}

export async function doctor(supplied = {}) {
  const options = defaults(supplied);
  let installation;
  try { installation = await findRuntime(options.runtime); await loadRuntime(options.runtime); }
  catch (error) { return { ok: false, node: process.version, ...errorInfo(error), installation, paths: options }; }
  return { ok: true, node: process.version, dshVersion: installation.version, runtime: installation.root,
    claudeRoot: options.claudeRoot, claudeFound: await exists(options.claudeRoot), targetRoot: options.targetRoot,
    codebuddyRoot: options.codebuddyRoot, codebuddyFound: await exists(options.codebuddyRoot),
    targetFound: await exists(options.targetRoot), dataDir: options.dataDir, appLogFound: await exists(options.appLog) };
}
