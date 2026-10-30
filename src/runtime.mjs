import { createRequire } from 'node:module';
import { readFile, realpath, access } from 'node:fs/promises';
import { dirname, join, resolve, delimiter } from 'node:path';
import { ToolError, check } from './errors.mjs';

export const TESTED_DSH_VERSION = '0.2.1-rc.2';
const cache = new Map();

export async function findRuntime(explicit = process.env.DSH_PACKAGE_ROOT) {
  const candidates = [];
  if (explicit) candidates.push(resolve(explicit));
  else {
    for (const directory of (process.env.PATH || '').split(delimiter)) {
      try {
        const executable = await realpath(join(directory, process.platform === 'win32' ? 'dsh.cmd' : 'dsh'));
        candidates.push(resolve(dirname(executable), '..'));
      } catch { /* Not a dsh installation. */ }
    }
    candidates.push(resolve(dirname(process.execPath), '../lib/node_modules/@deepseek-ai/dsh'));
    try { candidates.push(dirname(createRequire(import.meta.url).resolve('@deepseek-ai/dsh/package.json'))); } catch { /* Optional local dependency. */ }
  }
  for (const root of [...new Set(candidates)]) {
    try {
      const packagePath = join(root, 'package.json');
      const pkg = JSON.parse(await readFile(packagePath, 'utf8'));
      if (pkg.name === '@deepseek-ai/dsh') return { root, packagePath, version: pkg.version };
    } catch { /* Try another installation. */ }
  }
  throw new ToolError('DSH_NOT_FOUND', '找不到 dsh 安装。请先安装 dsh，或用 --runtime /path/to/@deepseek-ai/dsh 指定现有安装。');
}

export async function loadRuntime(explicit) {
  check(Number(process.versions.node.split('.')[0]) >= 24, 'NODE_VERSION', '需要 Node.js 24 或更新版本（内置 Zstandard）。');
  const installation = await findRuntime(explicit);
  check(installation.version === TESTED_DSH_VERSION, 'DSH_VERSION', `已安装 dsh ${installation.version}；当前适配器只验证过 ${TESTED_DSH_VERSION}，暂不写入其他版本。`);
  if (cache.has(installation.root)) return cache.get(installation.root);
  const require = createRequire(installation.packagePath);
  const load = name => import(require.resolve(`@deepseek-ai/${name}`));
  const [cordis, session, llm, persistence, projections, attachment, storage, storageJson, storageDomain, workspace] = await Promise.all([
    load('cordis'), load('dsh-session'), load('dsh-llm'), load('dsh-session-persistence-jsonl'),
    import(require.resolve('@deepseek-ai/dsh-session-format-catalog/message-projections')),
    load('dsh-attachment-local'), load('dsh-storage'), load('dsh-storage-json'), load('dsh-storage-domain'), load('dsh-workspace'),
  ]);
  check(session.SESSION_FORMAT_VERSION === 4, 'DSH_FORMAT', 'dsh 会话格式不是已验证的 v4。');
  const runtime = { ...installation, ...cordis, ...session, ...llm, persistence, attachment, storage, storageJson, storageDomain, workspace,
    projections: projections.currentSessionMessageProjections };
  cache.set(installation.root, runtime);
  return runtime;
}

export async function withStore(runtime, root, callback) {
  const ctx = new runtime.Context();
  const scope = ctx.plugin(runtime.persistence, { root: resolve(root) });
  try { await scope.await(); return await callback(ctx.sessionPersistence); }
  finally { await scope.dispose(); }
}

export async function withWorkspace(runtime, options, callback) {
  const ctx = new runtime.Context();
  const scopes = [];
  try {
    let scope = ctx.plugin(runtime.persistence, { root: resolve(options.targetRoot) });
    scopes.push(scope); await scope.await();
    scope = scope.context.plugin(runtime.storage.default);
    scopes.push(scope); await scope.await();
    scope = scope.context.plugin(runtime.storageJson.apply, { root: resolve(options.workspaceStorageRoot) });
    scopes.push(scope); await scope.await();
    scope = scope.context.plugin(runtime.storageDomain.apply, { backend: 'json' });
    scopes.push(scope); await scope.await();
    scope = scope.context.plugin(runtime.workspace.default);
    scopes.push(scope); await scope.await();
    return await callback(scope.context.workspaceRegistry);
  } finally {
    for (const scope of scopes.reverse()) await scope.dispose();
  }
}

export async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
