// check_delivery over a fixture repository with a bare origin, both made in a
// temporary folder, and a work order built here. The order's signature does not
// verify: the rehearsal runs either way and says what read_order would say.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

import { HANDLERS, checkDelivery } from '../src/handlers.mjs';
import { CHECK_DELIVERY } from '../src/tools.mjs';
import { validate } from '../src/validate.mjs';

const NODE = process.execPath;
const ENV_NAMES = ['TMPDIR', 'TEMP', 'TMP'];

let root;
let scratch;
let checkout;
const saved = {};
const commits = {};

const git = (cwd, ...args) =>
  execFileSync(
    'git',
    ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();

const write = (path, content) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
};

/** A work order as read_order reads one, its signature not made. */
function orderText({ base, territory, checks }) {
  return JSON.stringify({
    schema: 'tick.work-order.v1',
    alg: 'ed25519',
    order_id: 'fixture-order',
    order: {
      what: 'Change the fixture.',
      repository: 'origin.git',
      base,
      territory,
      checks: { commands: checks },
      budget: { cap_usd: 1 },
      deadline: null,
      acceptor: { kind: 'checks' },
      payment: { kind: 'none' },
      from_task: null,
    },
  });
}

const node = (name, script) => ({ name, argv: [NODE, '-e', script] });

/** What the given checkout holds: its commits, its status and every file in it. */
function snapshot() {
  const files = {};
  const walk = (folder, prefix) => {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (entry.name === '.git' && prefix === '') continue;
      const path = join(folder, entry.name);
      if (entry.isDirectory()) walk(path, `${prefix}${entry.name}/`);
      else files[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
    }
  };
  walk(checkout, '');
  return {
    head: git(checkout, 'rev-parse', 'HEAD'),
    branch: git(checkout, 'branch', '--show-current'),
    refs: git(checkout, 'for-each-ref'),
    status: git(checkout, 'status', '--porcelain'),
    files,
  };
}

before(() => {
  root = mkdtempSync(join(tmpdir(), 'check-delivery-test-'));
  scratch = join(root, 'scratch');
  mkdirSync(scratch);
  const origin = join(root, 'origin.git');
  checkout = join(root, 'checkout');

  git(root, 'init', '--bare', '-b', 'main', origin);
  git(root, 'clone', '--quiet', origin, checkout);
  git(checkout, 'symbolic-ref', 'HEAD', 'refs/heads/main');
  write(join(checkout, 'src', 'a.txt'), 'a\n');
  write(join(checkout, 'docs', 'notes.md'), 'notes\n');
  write(join(checkout, 'ok.txt'), 'ok\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '--quiet', '-m', 'base');
  git(checkout, 'push', '--quiet', 'origin', 'main');
  commits.base = git(checkout, 'rev-parse', 'HEAD');

  git(checkout, 'checkout', '--quiet', '-b', 'inside');
  write(join(checkout, 'src', 'a.txt'), 'a changed\n');
  write(join(checkout, 'src', 'new.txt'), 'new\n');
  write(join(checkout, 'ok.txt'), 'ok changed\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '--quiet', '-m', 'inside the territory');
  commits.inside = git(checkout, 'rev-parse', 'HEAD');

  git(checkout, 'checkout', '--quiet', '-b', 'outside', commits.base);
  write(join(checkout, 'src', 'a.txt'), 'a changed\n');
  write(join(checkout, 'docs', 'notes.md'), 'notes changed\n');
  git(checkout, 'add', '-A');
  git(checkout, 'commit', '--quiet', '-m', 'touches the buyer\'s file');
  commits.outside = git(checkout, 'rev-parse', 'HEAD');

  // The checkout is left on a branch, with work in it that is not committed.
  git(checkout, 'checkout', '--quiet', 'inside');
  write(join(checkout, 'src', 'a.txt'), 'a, being edited\n');
  write(join(checkout, 'scratch.txt'), 'not committed\n');

  // The copies go to a folder of their own, so what is left of them can be seen.
  for (const name of ENV_NAMES) saved[name] = process.env[name];
  for (const name of ENV_NAMES) process.env[name] = scratch;
});

after(() => {
  for (const name of ENV_NAMES) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(root, { recursive: true, force: true });
});

const TERRITORY = ['src', './ok.txt'];

const rehearse = async (commit, checks, options) => {
  const args = {
    order: orderText({ base: commits.base, territory: TERRITORY, checks }),
    repository: checkout,
    commit,
  };
  const answer = await checkDelivery(args, options);
  assert.deepEqual(validate(CHECK_DELIVERY.outputSchema, answer, 'result'), []);
  assert.deepEqual(readdirSync(scratch), [], 'the temporary folder is removed afterwards');
  return answer;
};

test('a commit inside the territory whose checks pass is passed', async () => {
  const untouched = snapshot();
  const answer = await rehearse(commits.inside, [
    // The commit's files are there; the checkout's uncommitted ones are not.
    node(
      'tree',
      "const fs = require('node:fs');" +
        "if (fs.readFileSync('src/a.txt', 'utf8') !== 'a changed\\n') process.exit(2);" +
        "fs.accessSync('src/new.txt');" +
        "if (fs.existsSync('scratch.txt')) process.exit(9);",
    ),
    node('quiet', 'console.log("fine")'),
  ]);
  assert.equal(answer.commit, commits.inside);
  assert.equal(answer.territory_held, true);
  assert.deepEqual(answer.outside, []);
  assert.deepEqual(
    answer.results.map(({ name, outcome, exit_code }) => ({ name, outcome, exit_code })),
    [
      { name: 'tree', outcome: 'passed', exit_code: 0 },
      { name: 'quiet', outcome: 'passed', exit_code: 0 },
    ],
  );
  assert.match(answer.results[1].output_tail, /fine/);
  assert.equal(answer.verdict, 'passed');
  assert.ok(answer.limits.some((limit) => /signs nothing/.test(limit)));
  // The order here carries no signature, and the answer says so.
  assert.ok(answer.limits.some((limit) => /not genuine/.test(limit)));
  assert.deepEqual(snapshot(), untouched);
});

test('a name git resolves in the clone is taken for the commit', async () => {
  const answer = await rehearse('inside', [node('quiet', 'process.exit(0)')]);
  assert.equal(answer.commit, commits.inside);
  assert.equal(answer.verdict, 'passed');
});

test('a commit touching a file outside the territory is failed and names the file', async () => {
  const untouched = snapshot();
  const answer = await rehearse(commits.outside, [node('quiet', 'process.exit(0)')]);
  assert.equal(answer.territory_held, false);
  assert.deepEqual(answer.outside, ['docs/notes.md']);
  assert.equal(answer.results[0].outcome, 'passed');
  assert.equal(answer.verdict, 'failed');
  assert.deepEqual(snapshot(), untouched);
});

test('a failing check is failed with its exit code and the end of its output', async () => {
  const answer = await rehearse(commits.inside, [
    node('fails', 'console.log("one"); console.error("about to fail"); process.exit(3)'),
    node('passes', 'process.exit(0)'),
  ]);
  assert.equal(answer.territory_held, true);
  const [fails, passes] = answer.results;
  assert.equal(fails.outcome, 'failed');
  assert.equal(fails.exit_code, 3);
  assert.match(fails.output_tail, /about to fail/);
  assert.ok(Number.isInteger(fails.duration_ms) && fails.duration_ms >= 0);
  assert.equal(passes.outcome, 'passed', 'the checks after a failure still run');
  assert.equal(answer.verdict, 'failed');
});

test('a check that cannot be started is not-run, and the delivery is failed', async () => {
  const answer = await rehearse(commits.inside, [
    { name: 'missing', argv: [join(root, 'no-such-program')] },
  ]);
  assert.equal(answer.results[0].outcome, 'not-run');
  assert.equal(answer.results[0].exit_code, null);
  assert.equal(answer.verdict, 'failed');
});

test('a check that runs past its time limit is failed', async () => {
  const answer = await rehearse(
    commits.inside,
    [node('slow', 'setTimeout(() => {}, 60000)'), node('after', 'process.exit(0)')],
    { timeoutMs: 400 },
  );
  const [slow, next] = answer.results;
  assert.equal(slow.outcome, 'failed');
  assert.equal(slow.exit_code, null);
  assert.match(slow.output_tail, /time limit/);
  assert.ok(slow.duration_ms >= 300 && slow.duration_ms < 30000, `took ${slow.duration_ms} ms`);
  assert.equal(next.outcome, 'passed');
  assert.equal(answer.verdict, 'failed');
});

test('a commit the clone does not hold, and an order with nothing to run, are tool errors', async () => {
  const order = orderText({ base: commits.base, territory: TERRITORY, checks: [node('quiet', 'process.exit(0)')] });
  await assert.rejects(
    HANDLERS.check_delivery({ order, repository: checkout, commit: 'f'.repeat(40) }),
    /not a commit of the repository/,
  );
  await assert.rejects(
    HANDLERS.check_delivery({ order, repository: join(root, 'nowhere'), commit: commits.inside }),
    /is not a folder/,
  );
  await assert.rejects(
    HANDLERS.check_delivery({ order: '{}', repository: checkout, commit: commits.inside }),
    /names no base commit/,
  );
  assert.deepEqual(readdirSync(scratch), []);
});

test('the given checkout is untouched afterwards', () => {
  const state = snapshot();
  assert.equal(state.branch, 'inside');
  assert.equal(state.head, commits.inside);
  assert.equal(state.files['src/a.txt'], 'a, being edited\n');
  assert.equal(state.files['scratch.txt'], 'not committed\n');
  assert.match(state.status, /src\/a\.txt/);
  assert.match(state.status, /\?\? scratch\.txt/);
});
