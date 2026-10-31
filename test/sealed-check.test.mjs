// Sealed checks in check_delivery: a check whose name carries `suite sha256 <64 hex>`
// is not run, since the suite's files are not in the doer's tree.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { checkDelivery } from '../src/handlers.mjs';
import { CHECK_DELIVERY } from '../src/tools.mjs';
import { validate } from '../src/validate.mjs';

const NODE = process.execPath;
const HASH = 'ab'.repeat(32);

let root;
let repo;
const commits = {};

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

const orderText = (checks) =>
  JSON.stringify({
    schema: 'tick.work-order.v1',
    alg: 'ed25519',
    order_id: 'sealed-order',
    order: {
      what: 'Change the fixture.',
      repository: 'origin.git',
      base: commits.base,
      territory: ['src'],
      checks: { commands: checks },
      budget: { cap_usd: 1 },
      deadline: null,
      acceptor: { kind: 'checks' },
      payment: { kind: 'none' },
      from_task: null,
    },
  });

before(() => {
  root = mkdtempSync(join(tmpdir(), 'sealed-check-test-'));
  repo = join(root, 'repo');
  mkdirSync(join(repo, 'src'), { recursive: true });
  git(repo, 'init', '--quiet', '-b', 'main');
  writeFileSync(join(repo, 'src', 'a.txt'), 'a\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');
  commits.base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'src', 'a.txt'), 'a changed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'work');
  commits.work = git(repo, 'rev-parse', 'HEAD');
});

after(() => rmSync(root, { recursive: true, force: true }));

test('a sealed check is not run, an ordinary one is, and the verdict is passed', async () => {
  const marker = join(root, 'sealed-ran');
  const answer = await checkDelivery({
    order: orderText([
      { name: 'ordinary', argv: [NODE, '-e', 'console.log("ran")'] },
      {
        name: `round suite sha256 ${HASH}`,
        argv: [NODE, '-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); process.exit(1)`],
      },
    ]),
    repository: repo,
    commit: commits.work,
  });
  assert.deepEqual(validate(CHECK_DELIVERY.outputSchema, answer, 'result'), []);
  const [ordinary, sealed] = answer.results;
  assert.equal(ordinary.outcome, 'passed');
  assert.match(ordinary.output_tail, /ran/);
  assert.deepEqual(sealed, {
    name: `round suite sha256 ${HASH}`,
    outcome: 'not-run',
    exit_code: null,
    duration_ms: 0,
    output_tail: 'sealed: the referee runs this after you hand in',
  });
  assert.equal(existsSync(marker), false, 'the sealed check was never started');
  assert.equal(answer.verdict, 'passed');
  const line = answer.limits.find((limit) => /sealed/.test(limit));
  assert.ok(line, 'limits say a check is sealed');
  assert.match(line, /1 of the order's checks is sealed/);
  assert.match(line, /passing here says nothing about it/);
});

test('a sealed check that names a file absent from the tree is never executed', async () => {
  const answer = await checkDelivery({
    order: orderText([
      { name: `suite sha256 ${HASH} (hidden)`, argv: [NODE, 'tests/hidden-suite.mjs'] },
      { name: 'ordinary', argv: [NODE, '-e', 'process.exit(0)'] },
    ]),
    repository: repo,
    commit: commits.work,
  });
  assert.equal(answer.results[0].outcome, 'not-run');
  assert.equal(answer.results[0].exit_code, null);
  assert.equal(answer.results[0].duration_ms, 0);
  assert.equal(answer.results[0].output_tail, 'sealed: the referee runs this after you hand in');
  assert.equal(answer.verdict, 'passed');
});

test('a failing ordinary check still fails the verdict beside a sealed one', async () => {
  const answer = await checkDelivery({
    order: orderText([
      { name: `suite sha256 ${HASH}`, argv: [NODE, '-e', 'process.exit(0)'] },
      { name: 'fails', argv: [NODE, '-e', 'process.exit(3)'] },
    ]),
    repository: repo,
    commit: commits.work,
  });
  assert.equal(answer.verdict, 'failed');
});

test('a name that only looks like a sealed one is run', async () => {
  const answer = await checkDelivery({
    order: orderText([
      { name: `suite sha256 ${HASH.slice(2)}`, argv: [NODE, '-e', 'process.exit(0)'] },
      { name: `suite sha256 ${HASH}0`, argv: [NODE, '-e', 'process.exit(0)'] },
    ]),
    repository: repo,
    commit: commits.work,
  });
  assert.deepEqual(answer.results.map((result) => result.outcome), ['passed', 'passed']);
  assert.ok(!answer.limits.some((limit) => /sealed/.test(limit)));
});
