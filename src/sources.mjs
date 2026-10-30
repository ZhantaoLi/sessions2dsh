import { readSource, listClaude } from './claude.mjs';
import { convertClaude } from './convert.mjs';
import { readCodeBuddy, convertCodeBuddy, listCodeBuddy } from './codebuddy.mjs';
import { check } from './errors.mjs';

export function sourceAdapter(options) {
  const from = options.from || 'claude';
  check(['claude', 'codebuddy'].includes(from), 'SOURCE', '--from 仅支持 claude、codebuddy（list 另支持 dsh）。');
  if (from === 'codebuddy') return { kind: from, root: options.sourceRoot || options.codebuddyRoot, read: readCodeBuddy, convert: convertCodeBuddy, list: listCodeBuddy };
  return { kind: from, root: options.sourceRoot || options.claudeRoot, read: readSource, convert: convertClaude, list: listClaude };
}
