import { readFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { sha256 } from './claude.mjs';
import { check } from './errors.mjs';

export function snapshotDigest(input) {
  return sha256(JSON.stringify({ source: input.sourceSha256, files: (input.files || []).map(f => ({ backup: f.backup, sha256: f.sha256 })) }));
}

export async function checkSnapshot(input) {
  check(sha256(await readFile(input.source)) === input.sourceSha256, 'SOURCE_CHANGED', '源文件在准备期间被写入；请等待源会话结束。');
  for (const f of input.files || []) {
    check(await realpath(f.reference) === f.source && sha256(await readFile(f.source)) === f.sha256, 'SOURCE_CHANGED', '外置工具结果在准备期间发生变化。');
  }
}

export function backupFilePath(directory, name) {
  check(/^external\/[a-f0-9]{64}\.txt$/.test(name), 'MANIFEST', '外置来源备份名称不合法。');
  return resolve(join(directory, name));
}

export async function verifyFileBackups(directory, files = []) {
  for (const f of files) check(sha256(await readFile(backupFilePath(directory, f.backup))) === f.sha256, 'BACKUP_CHANGED', '外置工具结果备份校验失败。');
}

export async function sourceFilesState(files = []) {
  let missing = false;
  for (const f of files) {
    try {
      if (await realpath(f.reference || f.source) !== f.source || sha256(await readFile(f.source)) !== f.sha256) return 'changed';
    } catch (e) { if (e.code === 'ENOENT') missing = true; else throw e; }
  }
  return missing ? 'missing' : 'unchanged';
}
