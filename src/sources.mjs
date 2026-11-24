import { readSource, listClaude } from './claude.mjs';
import { convertClaude } from './convert.mjs';
import { readCodeBuddy, convertCodeBuddy, listCodeBuddy } from './codebuddy.mjs';
import { readAgy, convertAgy, listAgy } from './agy.mjs';
import { check } from './errors.mjs';

export function sourceAdapter(options) {
  const raw = options.from || 'claude';
  const from = raw === 'antigravity' ? 'agy' : raw;
  check(['claude', 'codebuddy', 'agy'].includes(from), 'SOURCE', '--from 仅支持 claude、codebuddy、agy（list 另支持 dsh）。');
  if (from === 'codebuddy') return { kind: from, root: options.sourceRoot || options.codebuddyRoot, read: readCodeBuddy, convert: convertCodeBuddy, list: listCodeBuddy };
  if (from === 'agy') return { kind: from, root: options.sourceRoot || options.agyRoot, read: readAgy, convert: convertAgy, list: listAgy };
  return { kind: from, root: options.sourceRoot || options.claudeRoot, read: readSource, convert: convertClaude, list: listClaude };
}
