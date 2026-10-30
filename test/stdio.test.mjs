// The server as a client runs it: server.mjs started as a child, spoken to over
// its stdin and heard over its stdout, in both eras of MCP.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TOOLS } from '../src/tools.mjs';

const SERVER = join(dirname(fileURLToPath(import.meta.url)), '..', 'server.mjs');
const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const INFO_KEY = 'io.modelcontextprotocol/serverInfo';
const MODERN = '2026-07-28';
const LEGACY = '2025-11-25';

/** Starts the server; `ask` sends a request and resolves with its answer. */
function start() {
  const child = spawn(process.execPath, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'] });
  const lines = [];
  const waiting = [];
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  createInterface({ input: child.stdout }).on('line', (line) => {
    const waiter = waiting.shift();
    if (waiter) waiter(line);
    else lines.push(line);
  });
  const nextLine = () =>
    lines.length ? Promise.resolve(lines.shift()) : new Promise((resolve) => waiting.push(resolve));
  let counter = 0;
  return {
    child,
    lines,
    stderr: () => stderr,
    send: (text) => child.stdin.write(`${text}\n`),
    async ask(method, params) {
      const id = ++counter;
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      const answer = JSON.parse(await nextLine());
      assert.equal(answer.jsonrpc, '2.0');
      assert.equal(answer.id, id);
      return answer;
    },
    nextLine,
    async finish() {
      child.stdin.end();
      const [code] = await once(child, 'close');
      return code;
    },
  };
}

const modernMeta = { _meta: { [VERSION_KEY]: MODERN } };
const call = (name, args, meta = modernMeta) => ({ name, arguments: args, ...meta });

test('modern: discover, then list, then call', async () => {
  const server = start();

  const discovered = (await server.ask('server/discover', {})).result;
  assert.equal(discovered.resultType, 'complete');
  assert.deepEqual(discovered.supportedVersions, [MODERN, LEGACY]);
  assert.deepEqual(discovered.capabilities, { tools: {} });
  const info = discovered._meta[INFO_KEY];
  assert.equal(typeof info.name, 'string');
  assert.equal(typeof info.version, 'string');
  assert.equal(typeof discovered.instructions, 'string');

  const listed = (await server.ask('tools/list', modernMeta)).result;
  assert.equal(listed.resultType, 'complete');
  assert.deepEqual(listed._meta[INFO_KEY], info);
  assert.deepEqual(listed.tools, JSON.parse(JSON.stringify(TOOLS)));

  // A well-formed call to a tool not built yet is a tool execution error,
  // never a made-up verdict.
  const called = (await server.ask('tools/call', call('check_delivery', { order: '{}', repository: '.', commit: 'HEAD' }))).result;
  assert.equal(called.resultType, 'complete');
  assert.deepEqual(called._meta[INFO_KEY], info);
  assert.equal(called.isError, true);
  assert.match(called.content[0].text, /not built yet/);
  assert.equal(called.structuredContent, undefined);

  assert.equal(await server.finish(), 0);
});

test('legacy: initialize, then list, then call, then ping', async () => {
  const server = start();

  const initialized = (await server.ask('initialize', {
    protocolVersion: LEGACY,
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  })).result;
  assert.equal(initialized.protocolVersion, LEGACY);
  assert.deepEqual(initialized.capabilities, { tools: {} });
  assert.equal(typeof initialized.serverInfo.name, 'string');
  assert.equal(typeof initialized.serverInfo.version, 'string');
  assert.equal(initialized.resultType, undefined);
  server.send(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));

  const listed = (await server.ask('tools/list')).result;
  assert.deepEqual(listed.tools.map((tool) => tool.name), TOOLS.map((tool) => tool.name));
  assert.equal(listed.resultType, undefined);

  const called = (await server.ask('tools/call', { name: 'check_delivery', arguments: { order: '{}', repository: '.', commit: 'HEAD' } })).result;
  assert.equal(called.isError, true);
  assert.match(called.content[0].text, /not built yet/);

  assert.deepEqual((await server.ask('ping')).result, {});

  assert.equal(await server.finish(), 0);
});

test('an unsupported revision gets -32022 with what is supported and what was asked', async () => {
  const server = start();
  const requested = '2031-01-01';
  const answer = await server.ask('tools/list', { _meta: { [VERSION_KEY]: requested } });
  assert.equal(answer.result, undefined);
  assert.equal(answer.error.code, -32022);
  assert.equal(answer.error.message, 'Unsupported protocol version');
  assert.deepEqual(answer.error.data, { supported: [MODERN, LEGACY], requested });
  assert.equal(await server.finish(), 0);
});

test('a bad argument is a tool execution error that names the field', async () => {
  const server = start();

  const wrongType = (await server.ask('tools/call', call('check_delivery', {
    order_path: 7,
    repository: '/tmp/clone',
    commit: 'HEAD',
  }))).result;
  assert.equal(wrongType.isError, true);
  assert.match(wrongType.content[0].text, /arguments\.order_path must be string, not number/);

  const missing = (await server.ask('tools/call', call('check_delivery', { order: '{}' }))).result;
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /arguments\.repository is required/);
  assert.match(missing.content[0].text, /arguments\.commit is required/);

  const neither = (await server.ask('tools/call', call('read_order', {}))).result;
  assert.equal(neither.isError, true);
  assert.match(neither.content[0].text, /order is required/);
  assert.match(neither.content[0].text, /order_path is required/);

  const both = (await server.ask('tools/call', call('read_order', { order: '{}', order_path: 'x' }))).result;
  assert.equal(both.isError, true);
  assert.match(both.content[0].text, /give only one of order, order_path/);

  const stray = (await server.ask('tools/call', call('read_order', { order: '{}', colour: 'red' }))).result;
  assert.equal(stray.isError, true);
  assert.match(stray.content[0].text, /arguments\.colour is not a field of this tool/);

  const notObject = (await server.ask('tools/call', call('read_order', 'order'))).result;
  assert.equal(notObject.isError, true);
  assert.match(notObject.content[0].text, /arguments must be object/);

  assert.equal(await server.finish(), 0);
});

test('protocol errors: unknown tool, unknown method, not JSON, not a request', async () => {
  const server = start();

  const unknownTool = await server.ask('tools/call', call('forge_receipt', {}));
  assert.equal(unknownTool.error.code, -32602);
  assert.match(unknownTool.error.message, /forge_receipt/);

  const noName = await server.ask('tools/call', modernMeta);
  assert.equal(noName.error.code, -32602);

  const unknownMethod = await server.ask('resources/list', modernMeta);
  assert.equal(unknownMethod.error.code, -32601);

  server.send('this is not json');
  const parse = JSON.parse(await server.nextLine());
  assert.equal(parse.id, null);
  assert.equal(parse.error.code, -32700);

  server.send('[1]');
  const invalid = JSON.parse(await server.nextLine());
  assert.equal(invalid.error.code, -32600);

  // Still alive and in step after all that.
  assert.deepEqual((await server.ask('ping')).result, {});
  assert.equal(await server.finish(), 0);
});

test('stdout carries only messages, one per line; logs go to stderr', async () => {
  const server = start();
  await server.ask('server/discover', {});
  server.send('{"jsonrpc":"2.0","method":"notifications/initialized"}');
  server.send('');
  await server.ask('tools/list', modernMeta);
  server.send('not json');
  await server.nextLine();

  const chunks = [];
  server.child.stdout.on('data', (chunk) => chunks.push(chunk));
  assert.equal(await server.finish(), 0);
  // Anything left on stdout after the exchange is a message too: nothing
  // arrived unasked-for, and every line parsed as a message in `ask`.
  assert.equal(Buffer.concat(chunks).length, 0);
  assert.equal(server.lines.length, 0);
  assert.match(server.stderr(), /exiting/);
});

test('every line on stdout is a JSON-RPC message with no newline inside it', async () => {
  const server = start();
  const sent = [
    { jsonrpc: '2.0', id: 1, method: 'server/discover' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: modernMeta },
    { jsonrpc: '2.0', id: 3, method: 'nope' },
  ];
  const raw = [];
  server.child.stdout.on('data', (chunk) => raw.push(chunk));
  for (const message of sent) server.send(JSON.stringify(message));
  assert.equal(await server.finish(), 0);
  const text = Buffer.concat(raw).toString('utf8');
  assert.ok(text.endsWith('\n'));
  const lines = text.split('\n').slice(0, -1);
  assert.equal(lines.length, sent.length);
  for (const line of lines) {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    assert.ok('result' in message || 'error' in message);
  }
});

test('the server exits when its input ends', async () => {
  const server = start();
  await server.ask('ping');
  const closed = once(server.child, 'close');
  server.child.stdin.end();
  const [code, signal] = await closed;
  assert.equal(code, 0);
  assert.equal(signal, null);
});
