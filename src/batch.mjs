import { mkdir, readFile, readdir, writeFile, rename } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { defaults, listSessions, importSession, verifySession, APP_RESTART_HINT } from './manager.mjs';
import { loadRuntime, withStore, exists } from './runtime.mjs';
import { sha256 } from './claude.mjs';
import { errorInfo, check } from './errors.mjs';
import { connectApp, appIsRunning } from './app.mjs';
import { sourceAdapter } from './sources.mjs';

async function saveReport(path, report) {
  if (!path) return;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(`${path}.next`, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  await rename(`${path}.next`, path);
}
async function backupJournals(source, backup) {
  const folder = source.slice(0, -'.jsonl'.length);
  const entries = [];
  if (!(await exists(folder))) return entries;
  async function walk(dir, relative = '') {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), name = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path, name);
      else if (entry.name === 'journal.jsonl') {
        const bytes = await readFile(path), digest = sha256(bytes), target = join(backup, 'auxiliary', name);
        await mkdir(dirname(target), { recursive: true, mode: 0o700 });
        if (await exists(target)) check(sha256(await readFile(target)) === digest, 'AUXILIARY_CHANGED', `工作流日志已有不同备份：${path}`);
        else await writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
        check(sha256(await readFile(path)) === digest && sha256(await readFile(target)) === digest, 'AUXILIARY_CHANGED', `工作流日志备份期间发生变化：${path}`);
        entries.push({ source: path, backup: target, sha256: digest, kind: 'workflow-journal' });
      }
    }
  }
  await walk(folder);
  if (entries.length) await writeFile(join(backup, 'auxiliary.json'), JSON.stringify(entries, null, 2), { mode: 0o600 });
  return entries;
}
export async function batchImport(supplied = {}) {
  const options = defaults(supplied);
  const adapter = sourceAdapter(options);
  if (options.write && options.app) options._rpc = await connectApp(options.appLog);
  const candidates = (await listSessions(options)).filter(item => !options.project || [item.project, item.cwd, item.title, item.id].some(value => value?.toLowerCase().includes(options.project.toLowerCase())));
  const report = { schemaVersion: 1, startedAt: new Date().toISOString(), write: !!options.write,
    sourceKind: adapter.kind, targetRoot: options.targetRoot, includeSubagents: !!options.includeSubagents, repairInterrupted: !!options.repairInterrupted,
    results: [], totals: { candidates: candidates.length, imported: 0, existing: 0, preview: 0, skipped: 0, failed: 0, applicationFailed: 0, workspaceFailed: 0, journals: 0 } };
  let workspaceChanged = false;
  async function run(store) {
    for (const candidate of candidates) {
      const item = { source: candidate.source, kind: candidate.kind, sourceSessionId: candidate.id, agentId: candidate.agentId };
      try {
        if (candidate.skipReason) {
          item.status = 'skipped'; item.reason = candidate.skipReason; report.totals.skipped++;
        } else {
        check(!candidate.error, 'SOURCE_READ', candidate.error);
        const result = await importSession(candidate.source, { ...options, _store: store, _suppressAppRestartHint: true });
        workspaceChanged ||= result.workspace?.ok === true && result.workspace.status !== 'attached';
        Object.assign(item, result);
        if (options.write) {
          item.verification = await verifySession(result.id, { ...options, app: false, _store: store });
          if (adapter.kind === 'claude' && !candidate.agentId) item.journals = await backupJournals(candidate.source, result.backup);
        }
        report.totals[result.status === 'imported' ? 'imported' : result.status === 'already-imported' ? 'existing' : 'preview']++;
        if (result.application?.ok === false) report.totals.applicationFailed++;
        if (result.workspace?.ok === false) report.totals.workspaceFailed++;
        report.totals.journals += item.journals?.length || 0;
        }
      } catch (error) {
        Object.assign(item, { status: 'failed', ...errorInfo(error) }); report.totals.failed++;
      }
      report.results.push(item);
      await saveReport(options.report, report);
      options.onProgress?.({ completed: report.results.length, total: candidates.length, status: item.status, id: item.id, error: item.code });
    }
  }
  const runtime = await loadRuntime(options.runtime);
  if (options.write || await exists(options.targetRoot)) await withStore(runtime, options.targetRoot, run);
  else await run(undefined); // Read-only preview must not create the destination.
  report.finishedAt = new Date().toISOString();
  if (workspaceChanged &&
    (options._appRunning === undefined ? await appIsRunning(options.appLog) : options._appRunning)) {
    report.warnings = [APP_RESTART_HINT];
  }
  report.ok = !report.totals.failed && !report.totals.applicationFailed && !report.totals.workspaceFailed;
  await saveReport(options.report, report);
  return report;
}
