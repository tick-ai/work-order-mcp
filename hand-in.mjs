#!/usr/bin/env node
// For an agent with no MCP client: hands work in against a work order.
//   node hand-in.mjs <order.json> <repo> <commit> <out> [--agent NAME] [--model NAME] [--minutes N]

import { handIn } from './src/hand-in.mjs';

const USAGE =
  'usage: node hand-in.mjs <order.json> <repo> <commit> <out folder> [--agent NAME] [--model NAME] [--minutes N]';

const words = process.argv.slice(2);
const flag = (name) => {
  const at = words.indexOf(`--${name}`);
  if (at < 0) return undefined;
  const value = words[at + 1];
  words.splice(at, value === undefined ? 1 : 2);
  return value ?? '';
};
const agent = flag('agent');
const model = flag('model');
const minutes = flag('minutes');
const [orderPath, repository, commit, out, ...extra] = words;

if (!orderPath || !repository || !commit || !out || extra.length > 0 || agent === '' || model === '' || minutes === '') {
  console.error(USAGE);
  process.exit(2);
}

try {
  const answer = await handIn({
    order_path: orderPath,
    repository,
    commit,
    out,
    agent: agent ?? 'unknown agent',
    ...(model !== undefined ? { model } : {}),
    ...(minutes !== undefined ? { minutes: Number(minutes) } : {}),
  });
  console.log(`handed in ${answer.commit.slice(0, 12)} under key ${answer.key_id}: ${answer.folder}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
