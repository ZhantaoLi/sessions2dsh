import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connectApp, inspectApp } from '../src/app.mjs';

test('application verification uses authenticated local API without prompts or tool execution', async () => {
  const temporaryRoot = new URL('../tmp/tests', import.meta.url).pathname;
  await mkdir(temporaryRoot, { recursive: true });
  const folder = await mkdtemp(join(temporaryRoot, 'app-'));
  const events = [{ type: 'session/end-seed', seq: 0, time: 1, data: {} }];
  const methods = [];
  const server = createServer(async (request, response) => {
    if (request.url === '/?token=fixture-token') {
      response.writeHead(303, { 'set-cookie': 'fixture-cookie=value; HttpOnly', location: '/' }); response.end(); return;
    }
    assert.equal(request.headers.cookie, 'fixture-cookie=value');
    assert.equal(request.headers.origin, `http://127.0.0.1:${server.address().port}`);
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); methods.push(body.method);
    let value;
    if (body.method === 'session/projections') value = { kind: 'sequenced', asOfSeq: 0, values: { title: 'Fixture' } };
    if (body.method === 'session/page') {
      assert.equal(body.payload.args.request.throughSeq, 0);
      // Deliberately different object key order from expected history.
      value = { records: [{ type: 'event', event: { data: {}, time: 1, seq: 0, type: 'session/end-seed' } }], hasMore: false };
    }
    if (body.method === 'session/list') value = { items: [{ sessionId: 'session-fixture', agentAvailable: false, running: false }] };
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const log = join(folder, 'launcher.log');
    await writeFile(log, `dsh web: http://127.0.0.1:${server.address().port}/?token=fixture-token\n`);
    const result = await inspectApp(await connectApp(log), 'session-fixture', events);
    assert.equal(result.listed, true); assert.equal(result.historyMatches, true);
    assert.deepEqual(methods, ['session/projections', 'session/page', 'session/list']);
    assert(!JSON.stringify(result).includes('fixture-token'));
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); }
});

test('application launch log cannot redirect credentials to a remote host', async () => {
  const root = new URL('../tmp/tests', import.meta.url).pathname;
  await mkdir(root, { recursive: true });
  const folder = await mkdtemp(join(root, 'origin-'));
  try {
    const log = join(folder, 'launcher.log');
    await writeFile(log, 'dsh web: https://example.com/?token=private-test-token\n');
    await assert.rejects(connectApp(log), error => error.code === 'APP_ORIGIN' && !error.message.includes('private-test-token'));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('application verification follows backwards pages and rejects a stuck cursor', async () => {
  const expected = Array.from({ length: 6 }, (_, seq) => ({ type: 'fixture', seq, time: 1, data: {} }));
  const cuts = [];
  const rpc = async (method, args) => {
    if (method === 'session/projections') return { kind: 'sequenced', asOfSeq: 8, values: {} };
    if (method === 'session/list') return { items: [{ sessionId: 'fixture' }] };
    const request = args.request; cuts.push(request.beforeSeq);
    assert.equal(request.throughSeq, 5);
    const end = request.beforeSeq ?? 6, start = Math.max(0, end - 2);
    return { records: expected.slice(start, end).map(event => ({ type: 'event', event })), hasMore: start > 0 };
  };
  assert.equal((await inspectApp(rpc, 'fixture', expected)).historyMatches, true);
  assert.deepEqual(cuts, [undefined, 4, 2]);
  const stuck = async (method, args) => method === 'session/page'
    ? { records: [{ type: 'event', event: expected[4] }], hasMore: true } : rpc(method, args);
  await assert.rejects(inspectApp(stuck, 'fixture', expected), { code: 'APP_HISTORY' });
});
