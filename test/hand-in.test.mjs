// hand_in over a fixture repository made in a temporary folder with real git, no network.
// Orders are signed here with node:crypto, as a buyer's key would sign them, and the
// doer's key lives in a temporary TICK_ID_HOME.

import assert from 'node:assert/strict';
import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

import { HANDLERS } from '../src/handlers.mjs';
import { handIn } from '../src/hand-in.mjs';
import { HAND_IN, TOOLS } from '../src/tools.mjs';
import { validate } from '../src/validate.mjs';
import { documentHash, verifyDocument } from '../src/verify.js';

const NODE = process.execPath;
const CLI = fileURLToPath(new URL('../hand-in.mjs', import.meta.url));
const TERRITORY = ['src', './ok.txt'];

let root;
let repo;
let idHome;
let savedHome;
let counter = 0;
const commits = {};
const buyer = generateKeyPairSync('ed25519');

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

/** A work order signed by the buyer's key the way the specification says. */
async function signedOrder({ base, territory = TERRITORY, what = 'Change the fixture.' }) {
  const order = {
    what,
    repository: 'origin.git',
    base,
    territory,
    checks: { commands: [{ name: 'quiet', argv: [NODE, '-e', 'process.exit(0)'] }] },
    budget: { cap_usd: 1 },
    deadline: null,
    acceptor: { kind: 'checks' },
    payment: { kind: 'none' },
    from_task: null,
  };
  const spki = createPublicKey(buyer.privateKey).export({ type: 'spki', format: 'der' });
  const orderId = randomUUID();
  const contentHash = await documentHash(order);
  return JSON.stringify({
    schema: 'tick.work-order.v1',
    alg: 'ed25519',
    issued_at: new Date().toISOString(),
    coordinator: 'fixture',
    order_id: orderId,
    order,
    content_hash: contentHash,
    checks_hash: await documentHash(order.checks),
    key: spki.toString('base64'),
    key_id: createHash('sha256').update(spki).digest('hex').slice(0, 16),
    signature: sign(null, Buffer.from(`tick-work-order:v1:${orderId}:${contentHash}`, 'utf8'), buyer.privateKey).toString('base64'),
  });
}

const freshOut = () => join(root, `out-${++counter}`, 'folder');
const refs = () => git(repo, 'for-each-ref', 'refs/tick');

const keyText = () => readFileSync(join(idHome, 'id.pem'), 'utf8');
const keyBody = () => keyText().split('\n').filter((line) => line !== '' && !line.startsWith('-----')).join('');

before(() => {
  root = mkdtempSync(join(tmpdir(), 'hand-in-test-'));
  repo = join(root, 'repo');
  idHome = join(root, 'id-home');
  savedHome = process.env.TICK_ID_HOME;
  process.env.TICK_ID_HOME = idHome;

  mkdirSync(repo);
  git(repo, 'init', '--quiet', '-b', 'main');
  write(join(repo, 'src', 'a.txt'), 'a\n');
  write(join(repo, 'docs', 'notes.md'), 'notes\n');
  write(join(repo, 'ok.txt'), 'ok\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'base');
  commits.base = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', '--quiet', '-b', 'inside');
  write(join(repo, 'src', 'a.txt'), 'a changed\n');
  write(join(repo, 'src', 'new.txt'), 'new\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'inside the territory');
  write(join(repo, 'ok.txt'), 'ok changed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'second, inside the territory');
  commits.inside = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', '--quiet', '-b', 'outside', commits.base);
  write(join(repo, 'src', 'a.txt'), 'a changed\n');
  write(join(repo, 'docs', 'notes.md'), 'notes changed\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'touches the buyer\'s file');
  commits.outside = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', '--quiet', '--orphan', 'unrelated');
  git(repo, 'rm', '-rf', '--quiet', '.');
  write(join(repo, 'src', 'other.txt'), 'other\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '--quiet', '-m', 'does not descend from the base');
  commits.unrelated = git(repo, 'rev-parse', 'HEAD');

  git(repo, 'checkout', '--quiet', 'main');
});

after(() => {
  if (savedHome === undefined) delete process.env.TICK_ID_HOME;
  else process.env.TICK_ID_HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

const hand = async (overrides = {}) => {
  const out = freshOut();
  const order = overrides.order ?? (await signedOrder({ base: commits.base }));
  const answer = await handIn({ order, repository: repo, commit: commits.inside, out, agent: 'test agent', ...overrides });
  return { answer, out };
};

test('a hand-in gives a delivery that verifies, and one changed character does not', async () => {
  const { answer, out } = await hand({ model: 'test-model', minutes: 12.5 });
  assert.equal(answer.handed_in, true);
  assert.equal(answer.commit, commits.inside);
  assert.equal(answer.tree, git(repo, 'rev-parse', `${commits.inside}^{tree}`));
  assert.equal(answer.folder, out);
  assert.deepEqual(answer.files, ['delivery.json', 'work.bundle']);
  assert.deepEqual(readdirSync(out).sort(), ['delivery.json', 'work.bundle']);

  const text = readFileSync(join(out, 'delivery.json'), 'utf8');
  const verdict = await verifyDocument(text);
  assert.deepEqual(verdict.reasons, []);
  assert.equal(verdict.valid, true);
  assert.equal(verdict.kind, 'delivery');

  const doc = JSON.parse(text);
  assert.equal(doc.coordinator, `doer:${answer.key_id}`);
  assert.equal(doc.delivery_id, answer.delivery_id);
  assert.equal(doc.delivery.base, commits.base);
  assert.equal(doc.delivery.repository, 'origin.git');
  assert.deepEqual(doc.delivery.tries, [
    { agent: 'test agent', model: 'test-model', minutes: 12.5, cents: null, cost: 'unknown' },
  ]);
  assert.deepEqual(doc.limits, answer.limits);
  assert.equal(doc.limits.length, 3);

  const changed = text.replace('test agent', 'test agenT');
  assert.notEqual(changed, text);
  assert.equal((await verifyDocument(changed)).valid, false);

  assert.equal(refs(), '');
});

test('without a model or minutes the try says null', async () => {
  const { out } = await hand();
  const doc = JSON.parse(readFileSync(join(out, 'delivery.json'), 'utf8'));
  assert.equal(doc.delivery.tries[0].model, null);
  assert.equal(doc.delivery.tries[0].minutes, null);
  assert.equal((await verifyDocument(JSON.stringify(doc))).valid, true);
});

test('the bundle, fetched into a fresh clone of the base, gives the delivered commit and tree', async () => {
  const { answer, out } = await hand({ commit: 'inside' });
  assert.equal(answer.commit, commits.inside);
  const fresh = join(root, 'fresh');
  git(root, 'clone', '--quiet', '--branch', 'main', repo, fresh);
  assert.equal(git(fresh, 'rev-parse', 'HEAD'), commits.base);
  git(fresh, 'fetch', '--quiet', join(out, 'work.bundle'), 'refs/tick/delivery:refs/heads/delivered');
  assert.equal(git(fresh, 'rev-parse', 'delivered'), answer.commit);
  assert.equal(git(fresh, 'rev-parse', 'delivered^{tree}'), answer.tree);
  assert.equal(refs(), '');
});

test('two hand-ins share one key, and the key file is private', async () => {
  const first = await hand();
  const second = await hand();
  assert.equal(first.answer.key_id, second.answer.key_id);
  assert.notEqual(first.answer.delivery_id, second.answer.delivery_id);
  assert.match(first.answer.key_id, /^[0-9a-f]{16}$/);
  assert.ok(existsSync(join(idHome, 'id.pem')));
  if (process.platform !== 'win32') assert.equal(statSync(join(idHome, 'id.pem')).mode & 0o777, 0o600);
});

test('neither the key file\'s text nor its base64 body is in the answer or in any file in out', async () => {
  const { answer, out } = await hand();
  const text = keyText();
  const body = keyBody();
  assert.ok(body.length > 20);
  const answered = JSON.stringify(answer);
  assert.ok(!answered.includes(body) && !answered.includes(text.trim()));
  for (const name of readdirSync(out)) {
    const bytes = readFileSync(join(out, name));
    assert.ok(!bytes.includes(Buffer.from(body)), `${name} holds the key's body`);
    assert.ok(!bytes.includes(Buffer.from(text.trim())), `${name} holds the key's text`);
    assert.ok(!bytes.includes(Buffer.from(Buffer.from(text).toString('base64'))), `${name} holds the key file in base64`);
  }
});

test('an order with one character changed is refused, naming why, and writes nothing', async () => {
  const order = await signedOrder({ base: commits.base });
  const changed = order.replace('Change the fixture.', 'Change the fixtures.');
  assert.notEqual(changed, order);
  const out = freshOut();
  await assert.rejects(
    handIn({ order: changed, repository: repo, commit: commits.inside, out, agent: 'a' }),
    /not genuine.*content_hash is not the hash of the order/,
  );
  assert.ok(!existsSync(join(out, 'delivery.json')));
  assert.ok(!existsSync(out));
  assert.equal(refs(), '');
});

test('a commit that does not descend from the base is refused and writes nothing', async () => {
  const out = freshOut();
  await assert.rejects(
    handIn({ order: await signedOrder({ base: commits.base }), repository: repo, commit: commits.unrelated, out, agent: 'a' }),
    /not an ancestor/,
  );
  assert.ok(!existsSync(join(out, 'delivery.json')));
  assert.ok(!existsSync(out));
  assert.equal(refs(), '');
});

test('a changed file outside the territory is refused, named, and writes nothing', async () => {
  const out = freshOut();
  await assert.rejects(
    handIn({ order: await signedOrder({ base: commits.base }), repository: repo, commit: commits.outside, out, agent: 'a' }),
    /outside the order's territory: docs\/notes\.md/,
  );
  assert.ok(!existsSync(join(out, 'delivery.json')));
  assert.ok(!existsSync(out));
  assert.equal(refs(), '');
});

test('arguments that make no sense are refused before anything is written', async () => {
  const order = await signedOrder({ base: commits.base });
  const out = freshOut();
  const give = (more) => handIn({ order, repository: repo, commit: commits.inside, out, agent: 'a', ...more });
  await assert.rejects(give({ agent: '' }), /agent/);
  await assert.rejects(give({ minutes: -1 }), /minutes/);
  await assert.rejects(give({ minutes: Number.NaN }), /minutes/);
  await assert.rejects(give({ commit: 'f'.repeat(40) }), /not a commit/);
  await assert.rejects(give({ repository: join(root, 'nowhere') }), /not a folder/);
  await assert.rejects(handIn({ order_path: join(root, 'no-order.json'), repository: repo, commit: 'main', out, agent: 'a' }), /cannot be read/);
  assert.ok(!existsSync(out));
});

test('the hand_in answer conforms to its output schema', async () => {
  assert.ok(TOOLS.includes(HAND_IN));
  const out = freshOut();
  const answer = await HANDLERS.hand_in({
    order: await signedOrder({ base: commits.base }),
    repository: repo,
    commit: commits.inside,
    out,
    agent: 'test agent',
  });
  assert.deepEqual(validate(HAND_IN.outputSchema, answer, 'result'), []);
  assert.deepEqual(
    validate(HAND_IN.inputSchema, { order: '{}', repository: '.', commit: 'HEAD', out: 'x', agent: 'a', minutes: 3 }, 'arguments'),
    [],
  );
  assert.notDeepEqual(validate(HAND_IN.inputSchema, { order: '{}', repository: '.', commit: 'HEAD', out: 'x' }, 'arguments'), []);
});

const cli = (...args) => spawnSync(NODE, [CLI, ...args], { encoding: 'utf8', env: process.env });

test('the command line hands in, prints one line, and keeps the key out of it', async () => {
  const orderFile = join(root, 'order.json');
  writeFileSync(orderFile, await signedOrder({ base: commits.base }));
  const out = join(root, 'cli-out');
  const run = cli(orderFile, repo, commits.inside, out, '--agent', 'cli agent', '--model', 'm', '--minutes', '3');
  assert.equal(run.status, 0, run.stderr);
  const lines = run.stdout.trimEnd().split('\n');
  assert.equal(lines.length, 1);
  const match = /^handed in ([0-9a-f]{12}) under key ([0-9a-f]{16}): (.+)$/.exec(lines[0]);
  assert.ok(match, lines[0]);
  assert.equal(match[1], commits.inside.slice(0, 12));
  assert.ok(!run.stdout.includes(keyBody()));
  const text = readFileSync(join(out, 'delivery.json'), 'utf8');
  assert.equal((await verifyDocument(text)).valid, true);
  const doc = JSON.parse(text);
  assert.equal(doc.key_id, match[2]);
  assert.deepEqual(doc.delivery.tries, [{ agent: 'cli agent', model: 'm', minutes: 3, cents: null, cost: 'unknown' }]);

  const plain = cli(orderFile, repo, commits.inside, join(root, 'cli-out-2'));
  assert.equal(plain.status, 0, plain.stderr);
  const plainDoc = JSON.parse(readFileSync(join(root, 'cli-out-2', 'delivery.json'), 'utf8'));
  assert.equal(plainDoc.delivery.tries[0].agent, 'unknown agent');
  assert.equal(refs(), '');
});

test('the command line prints its usage and exits 2 when arguments are missing', () => {
  const run = cli('only-an-order.json');
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: .*hand-in\.mjs <order\.json> <repo> <commit> <out folder>/);
  assert.equal(run.stdout, '');
});

test('the command line prints a refusal to stderr and exits 1', async () => {
  const orderFile = join(root, 'changed-order.json');
  writeFileSync(orderFile, (await signedOrder({ base: commits.base })).replace('Change the fixture.', 'Change the fixtures.'));
  const out = join(root, 'cli-refused');
  const run = cli(orderFile, repo, commits.inside, out);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /not genuine/);
  assert.equal(run.stdout, '');
  assert.ok(!existsSync(out));
  assert.equal(refs(), '');
});
