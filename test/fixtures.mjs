// Synthetic, reusable fixtures; no private transcripts are committed.
export function transcript(id = 'fixture-session') {
  const base = { sessionId: id, cwd: '/fixture/workspace', isSidechain: false };
  const row = (type, uuid, content, seconds, extra = {}) => ({ ...base, type, uuid,
    timestamp: `2026-10-01T00:00:${String(seconds).padStart(2, '0')}.000Z`,
    message: { role: type, content, ...(type === 'assistant' ? { id: `msg-${uuid}`, model: 'fixture-model', stop_reason: 'end_turn' } : {}) }, ...extra });
  return [
    { type: 'mode', sessionId: id, mode: 'default' },
    row('user', 'u1', '查看示例文件，告诉我内容。', 0),
    row('assistant', 'a1', [{ type: 'thinking', thinking: 'Read the file.' }], 1, { message: { id: 'stream-1', role: 'assistant', model: 'fixture-model', content: [{ type: 'thinking', thinking: 'Read the file.' }], stop_reason: null } }),
    row('assistant', 'a2', [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'sample.txt' } }], 2,
      { message: { id: 'stream-1', role: 'assistant', model: 'fixture-model', content: [{ type: 'tool_use', id: 'call-1', name: 'Read', input: { path: 'sample.txt' } }], stop_reason: 'tool_use' } }),
    row('user', 'r1', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'Hello, session bridge!' }], 3),
    row('assistant', 'a3', [{ type: 'text', text: '文件内容是 Hello, session bridge!' }], 4),
  ];
}
export const jsonl = rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n';
