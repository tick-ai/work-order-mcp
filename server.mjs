#!/usr/bin/env node
// The work-order MCP server over stdio: one JSON-RPC message per line in, one
// per line out. Standard output carries messages and nothing else; logs go to
// standard error; the server ends when its input does.

import { createInterface } from 'node:readline';
import { respond } from './src/protocol.mjs';

const pending = new Set();

function handle(line) {
  const work = respond(line)
    .then((message) => {
      if (message) process.stdout.write(`${JSON.stringify(message)}\n`);
    })
    .catch((error) => {
      process.stderr.write(`work-order-mcp: ${error?.stack ?? error}\n`);
    })
    .finally(() => pending.delete(work));
  pending.add(work);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  if (line.trim() !== '') handle(line);
});
lines.on('close', async () => {
  // Answer what was asked before the input ended, then let the process end.
  await Promise.all(pending);
  process.stderr.write('work-order-mcp: input ended, exiting\n');
});
