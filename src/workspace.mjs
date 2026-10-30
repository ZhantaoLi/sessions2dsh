import { realpath, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { ToolError, check } from './errors.mjs';
import { withWorkspace } from './runtime.mjs';

export function workspaceOptions(options) {
  const dshHome = options.dshHome;
  return { ...options, workspaceStorageRoot: options.workspaceStorageRoot || join(dshHome, 'storages') };
}

export async function readDefaultWorkspace(options) {
  const path = join(options.workspaceStorageRoot, 'workspace.json');
  let document;
  try { document = JSON.parse(await readFile(path, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw new ToolError('WORKSPACE_REGISTRY', `无法读取 dsh 工作区注册表：${path}`);
  }
  const id = document?.global?.defaultWorkspaceId;
  const record = id && document?.tables?.workspaces?.[id];
  check(document?.unit?.name === 'workspace' && document.unit.version === 2 && document.global?.workspaceIds?.includes(id) &&
    typeof record?.path === 'string' && isAbsolute(record.path), 'WORKSPACE_REGISTRY', `dsh 工作区注册表缺少有效默认工作区：${path}`);
  return { id, path: record.path, title: record.title || basename(record.path), registryPath: path };
}

async function existingDirectory(path) {
  try { return (await stat(await realpath(path))).isDirectory(); }
  catch { return false; }
}

export async function resolveWorkspaceCwd(originalCwd, options) {
  if (!options.workspaceSync) return { cwd: options.cwd };
  const valid = await existingDirectory(originalCwd);
  const workspace = await readDefaultWorkspace(options);
  if (!valid) {
    check(workspace, 'WORKSPACE_DEFAULT', '来源 cwd 不可用，且 dsh 注册表没有可用的默认工作区。');
    check(await existingDirectory(workspace.path), 'WORKSPACE_DEFAULT', `dsh 默认工作区目录不存在：${workspace.path}`);
  }
  if (valid) {
    return { cwd: originalCwd, workspace: { sourceCwd: originalCwd, cwd: originalCwd, action: 'preserve-and-attach', ...(workspace ? { defaultWorkspace: workspace.path } : {}) } };
  }
  return { cwd: workspace.path, workspace: { sourceCwd: originalCwd, cwd: workspace.path, action: 'fallback-default-and-attach', reason: 'cwd-missing-or-not-directory', defaultWorkspace: workspace.path },
    warning: `来源 cwd 不可用，已改写为 dsh 默认工作区：${workspace.path}` };
}

/** Pick a display title no other Workspace uses: "<folder> (<parent>)" and, if that
 *  is taken too, keep walking up the path one level at a time. */
export function uniqueWorkspaceTitle(cwd, takenTitles) {
  const segments = resolve(cwd).split(sep).filter(Boolean);
  const base = segments.at(-1) ?? '';
  if (!takenTitles.has(base)) return base;
  const ancestors = segments.slice(0, -1).reverse();
  for (const suffix of [...ancestors, ancestors.join('/')]) {
    const candidate = `${base} (${suffix})`;
    if (!takenTitles.has(candidate)) return candidate;
  }
  return `${base} (${ancestors.join('/') || resolve(cwd)})`;
}

export async function syncWorkspace(plan, options, runtime) {
  if (!options.workspaceSync || !plan.workspace) return null;
  const { status: _status, error: _error, code: _code, ok: _ok, ...info } = plan.workspace;
  return withWorkspace(runtime, workspaceOptions(options), async registry => {
    const matched = await registry.resolveByPath(info.cwd);
    const workspace = matched || await registry.create(info.cwd,
      uniqueWorkspaceTitle(info.cwd, new Set(registry.list().map(entity => entity.title))));
    check(workspace, 'WORKSPACE_DEFAULT', `找不到可用工作区：${info.cwd}`);
    await workspace.attachSession(plan.header.id);
    return { ...info, ok: true, workspaceId: String(workspace.id), workspaceTitle: workspace.title,
      action: info.action === 'fallback-default-and-attach' ? info.action : matched ? 'matched-and-attached' : 'created-and-attached' };
  });
}

/** Read the latest on-disk registry; a running app may still hold an older copy. */
export async function pinImportedSession(id, options, runtime) {
  return withWorkspace(runtime, workspaceOptions(options), async registry => {
    const changed = !registry.pinnedSessionIds.includes(id);
    await registry.pinSession(id);
    return { ok: true, pinned: true, changed };
  });
}
