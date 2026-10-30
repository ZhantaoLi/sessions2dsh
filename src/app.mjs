import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { check, ToolError } from './errors.mjs';

/** Use the existing local launch token; never log or persist cookies/tokens. */
export async function connectApp(logPath) {
  let log;
  try { log = await readFile(logPath, 'utf8'); }
  catch { throw new ToolError('APP_UNAVAILABLE', `无法读取 dsh 启动日志：${logPath}。请启动 dsh web，或指定 --app-log。`); }
  const matches = [...log.matchAll(/dsh web: (https?:\/\/[^\s]+)/g)];
  check(matches.length, 'APP_UNAVAILABLE', '启动日志中没有 dsh Web 地址。');
  const launch = new URL(matches.at(-1)[1]);
  check(['127.0.0.1', '[::1]', 'localhost'].includes(launch.hostname) && !launch.username && !launch.password && launch.searchParams.has('token'),
    'APP_ORIGIN', '只允许连接带启动 token 的本机回环 dsh 地址。');
  const origin = launch.origin;
  let response;
  try { response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10000) }); }
  catch { throw new ToolError('APP_UNAVAILABLE', '无法连接本机 dsh Web；请检查应用是否运行。'); }
  check([302, 303].includes(response.status), 'APP_AUTH', `dsh 认证失败（HTTP ${response.status}），请刷新 --app-log。`);
  const cookie = response.headers.getSetCookie().map(value => value.split(';', 1)[0]).join('; ');
  check(cookie, 'APP_AUTH', 'dsh 没有返回认证 Cookie。');
  return async (method, args) => {
    let result;
    try {
      const response = await fetch(`${origin}/api/${method}`, {
        method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', cookie, origin },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
        signal: AbortSignal.timeout(30000),
      });
      check(response.ok, 'APP_HTTP', `${method} 返回 HTTP ${response.status}。`);
      result = (await response.json()).result;
    } catch (error) {
      if (error instanceof ToolError) throw error;
      throw new ToolError('APP_RPC', `调用 ${method} 失败；请检查本机 dsh 服务。`);
    }
    check(result?.ok, 'APP_RPC', `${method} 失败（${result?.error?.code || 'invalid-response'}）。`);
    return result.value;
  };
}

/** Report whether a local dsh Web is reachable, without failing when there is none. */
export async function appIsRunning(logPath) {
  try { await connectApp(logPath); return true; }
  catch { return false; }
}

export async function inspectApp(rpc, id, expectedEvents) {
  const projections = await rpc('session/projections', { request: { sessionId: id } });
  check(projections?.kind === 'sequenced', 'APP_FORMAT', '应用未返回当前格式会话投影。');
  // Only the imported prefix is needed. A session can grow well beyond this
  // prefix without making verification an unbounded history download.
  const pages = []; let beforeSeq;
  while (true) {
    const page = await rpc('session/page', { request: { address: { kind: 'session', sessionId: id }, throughSeq: expectedEvents.length - 1,
      maxMessages: 200, ...(beforeSeq === undefined ? {} : { beforeSeq }) } });
    const events = page.records.filter(record => record.type === 'event').map(record => record.event);
    pages.unshift(events);
    if (!page.hasMore) break;
    const next = events[0]?.seq;
    check(Number.isSafeInteger(next) && next > 0 && (beforeSeq === undefined || next < beforeSeq), 'APP_HISTORY', '应用历史分页没有向前推进。');
    beforeSeq = next;
  }
  const events = pages.flat();
  check(isDeepStrictEqual(events, expectedEvents), 'APP_HISTORY', '应用读回的导入前缀与备份不一致。');
  const summary = (await rpc('session/list', { _request: {} })).items.find(item => item.sessionId === id);
  check(summary, 'APP_NOT_LISTED', '应用会话列表没有该会话。');
  return { listed: true, historyMatches: true, title: summary.projections?.values?.title || projections.values.title,
    agentAvailable: summary.agentAvailable, running: summary.running, currentSeq: projections.asOfSeq };
}
