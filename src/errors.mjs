export class ToolError extends Error {
  constructor(code, message) { super(message); this.name = 'ToolError'; this.code = code; }
}
export function check(condition, code, message) {
  if (!condition) throw new ToolError(code, message);
}
export function errorInfo(error) {
  return { code: error.code || 'FAILED', message: error.message || String(error) };
}
