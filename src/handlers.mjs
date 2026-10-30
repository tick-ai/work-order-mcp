// The tools' working parts, by tool name: each takes the arguments the tool's
// inputSchema has already accepted and answers what its outputSchema describes,
// or throws an Error whose message says what to fix (a tool execution error).
// A tool with no entry here is not built yet.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { verifyDocument } from './verify.js';

const KEY_LIMIT =
  'Whether a key is the company\'s is not established here: hold key_id against a list you trust.';
const ROLES = ['buyer', 'doer', 'checker', 'acceptor'];

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

/** A document's text: given as it is, or read from the file at its path. */
async function documentText(args, name) {
  if (typeof args[name] === 'string') return args[name];
  const path = args[`${name}_path`];
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(`${name}_path ${JSON.stringify(path)} cannot be read: ${error.code ?? error.message}`);
  }
}

/** The first 16 hexadecimal characters of the SHA-256 of the carried key's bytes, or null. */
function keyIdOf(key) {
  if (typeof key !== 'string' || key === '' || !/^[A-Za-z0-9+/]*={0,2}$/.test(key)) return null;
  const bytes = Buffer.from(key, 'base64');
  return bytes.length === 0 ? null : createHash('sha256').update(bytes).digest('hex').slice(0, 16);
}

function commandsOf(order) {
  const commands = isObject(order.checks) ? order.checks.commands : undefined;
  if (!Array.isArray(commands)) return [];
  return commands
    .filter(
      (command) =>
        isObject(command) &&
        text(command.name) !== null &&
        Array.isArray(command.argv) &&
        command.argv.every((word) => typeof word === 'string'),
    )
    .map(({ name, argv }) => ({ name, argv }));
}

const fieldsOf = (order) => ({
  what: text(order.what),
  repository: text(order.repository),
  base: typeof order.base === 'string' && /^[0-9a-f]{40}$/.test(order.base) ? order.base : null,
  territory: Array.isArray(order.territory) ? order.territory.filter((path) => text(path) !== null) : [],
  checks: commandsOf(order),
  budget_usd:
    isObject(order.budget) && Number.isFinite(order.budget.cap_usd) && order.budget.cap_usd >= 0
      ? order.budget.cap_usd
      : null,
  deadline: text(order.deadline),
  acceptor: isObject(order.acceptor) ? order.acceptor : null,
  from_task: isObject(order.from_task) ? order.from_task : null,
});

async function readOrder(args) {
  const source = await documentText(args, 'order');
  const verdict = await verifyDocument(source);
  const reasons = [...verdict.reasons];
  const isOrder = verdict.kind === 'work-order';
  if (verdict.valid && !isOrder) reasons.push(`it is a ${verdict.kind}, not a work order`);

  let doc = null;
  if (isOrder) doc = JSON.parse(source);
  const order = doc !== null && isObject(doc.order) ? doc.order : {};
  return {
    genuine: verdict.valid && isOrder,
    reasons,
    key_id: doc === null ? null : keyIdOf(doc.key),
    order_id: doc === null ? null : text(doc.order_id),
    ...fieldsOf(order),
    limits: [...verdict.limits, KEY_LIMIT],
  };
}

async function explainReceipt(args) {
  const source = await documentText(args, 'receipt');
  const verdict = await verifyDocument(source);
  const reasons = [...verdict.reasons];
  const isReceipt = verdict.kind === 'receipt' && isObject(verdict.signers);
  if (verdict.valid && !isReceipt) {
    reasons.push(
      verdict.kind === 'receipt'
        ? 'it is a receipt of version one, not a receipt of version two'
        : `it is a ${verdict.kind}, not a receipt of version two`,
    );
  }
  const signers = isReceipt ? verdict.signers : {};
  return {
    kind: verdict.kind,
    valid: verdict.valid && isReceipt,
    reasons,
    roles: Object.fromEntries(ROLES.map((role) => [role, signers[role] ?? null])),
    shared: isReceipt ? verdict.shared : [],
    limits: [...verdict.limits, KEY_LIMIT],
  };
}

const CHECK_TIMEOUT_MS = 600_000;
const TAIL_LINES = 20;
const TAIL_BYTES = 4096;
const GIT_BUFFER = 64 * 1024 * 1024;

/** Runs git with the given arguments, no shell; resolves with its stdout or throws its words. */
function git(args, cwd) {
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      { cwd, encoding: 'utf8', maxBuffer: GIT_BUFFER, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      (error, stdout, stderr) => {
        if (error) fail(new Error(`git ${args[0]} failed: ${(stderr || error.message).trim()}`));
        else done(stdout);
      },
    );
  });
}

/** A path built at run time must be a non-empty string before a command takes it. */
function nonEmpty(path, what) {
  if (typeof path !== 'string' || path.trim() === '') throw new Error(`${what} came out empty; nothing was run`);
  return path;
}

/** A territory entry as a repository path: no leading "./", no trailing "/", "/" throughout. */
const territoryPath = (entry) => entry.replaceAll('\\', '/').replace(/^(\.\/)+/, '').replace(/\/+$/, '');

/** Whether a changed path lies in the territory: a listed file, or anything under a listed folder. */
const inTerritory = (path, territory) =>
  territory.map(territoryPath).some((entry) => entry !== '' && (path === entry || path.startsWith(`${entry}/`)));

/** The last lines of some output, bounded in lines and in bytes. */
function tailOf(output) {
  const lines = output.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
  const tail = lines.slice(-TAIL_LINES).join('\n');
  return tail.length > TAIL_BYTES ? tail.slice(-TAIL_BYTES) : tail;
}

/** Runs one check's argv in a folder, no shell, ending it at the time limit. */
function runCheck({ name, argv }, cwd, timeoutMs) {
  const started = performance.now();
  return new Promise((done) => {
    let output = '';
    let settled = false;
    let timer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ name, ...result, duration_ms: Math.round(performance.now() - started) });
    };
    const notRun = (error) =>
      finish({ outcome: 'not-run', exit_code: null, output_tail: `could not start: ${error.message}` });
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      notRun(error);
      return;
    }
    const keep = (chunk) => {
      output = (output + chunk).slice(-2 * TAIL_BYTES);
    };
    child.stdout.setEncoding('utf8').on('data', keep);
    child.stderr.setEncoding('utf8').on('data', keep);
    child.on('error', notRun);
    child.on('close', (code, signal) => {
      if (code === null) {
        finish({ outcome: 'failed', exit_code: null, output_tail: tailOf(`${output}\nended by ${signal}`) });
      } else {
        finish({ outcome: code === 0 ? 'passed' : 'failed', exit_code: code, output_tail: tailOf(output) });
      }
    });
    timer = setTimeout(() => {
      try {
        if (process.platform === 'win32') child.kill();
        else process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
      finish({
        outcome: 'failed',
        exit_code: null,
        output_tail: tailOf(`${output}\nstopped: ran past its time limit of ${timeoutMs} ms`),
      });
    }, timeoutMs);
  });
}

/** Makes a commit present in the clone, fetching it from the source when the clone lacks it. */
async function ensureCommit(folder, source, sha, what) {
  try {
    await git(['cat-file', '-e', `${sha}^{commit}`], folder);
  } catch {
    try {
      await git(['fetch', '--quiet', '--no-tags', '--', source, sha], folder);
    } catch {
      throw new Error(`${what} ${sha} is not in the repository ${source}`);
    }
  }
}

/** Copies the repository at the commit into a new temporary folder, rehearses the order's checks there, removes it. */
export async function checkDelivery(args, { timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const order = await readOrder(args);
  if (order.base === null) {
    throw new Error('the order names no base commit, so the changed files cannot be named: run read_order on it');
  }
  if (order.checks.length === 0) throw new Error('the order holds no checks to run: run read_order on it');

  const source = resolve(nonEmpty(args.repository, 'repository'));
  const info = await stat(source).catch(() => null);
  if (info === null || !info.isDirectory()) {
    throw new Error(`repository ${JSON.stringify(args.repository)} is not a folder`);
  }
  let commit;
  try {
    commit = (await git(['rev-parse', '--verify', '--end-of-options', `${args.commit}^{commit}`], source)).trim();
  } catch {
    throw new Error(`commit ${JSON.stringify(args.commit)} is not a commit of the repository ${source}`);
  }

  const root = nonEmpty(await mkdtemp(join(tmpdir(), 'check-delivery-')), 'the temporary folder');
  try {
    const folder = nonEmpty(join(root, 'tree'), 'the copy');
    await git(['clone', '--quiet', '--no-checkout', '--', source, folder]);
    await ensureCommit(folder, source, commit, 'commit');
    await ensureCommit(folder, source, order.base, 'base');
    await git(['checkout', '--quiet', '--detach', commit], folder);

    const changed = (await git(['diff', '--name-only', '--no-renames', '-z', `${order.base}..${commit}`], folder))
      .split('\0')
      .filter((path) => path !== '');
    const outside = changed.filter((path) => !inTerritory(path, order.territory));

    const results = [];
    for (const check of order.checks) results.push(await runCheck(check, folder, timeoutMs));

    const territoryHeld = outside.length === 0;
    const limits = [
      'A rehearsal: it signs nothing, and Tick\'s own check of the delivery decides.',
      `Each check ran here on this machine, not in a container, with a time limit of ${timeoutMs} ms; Tick's check may differ in machine, tools and time.`,
    ];
    if (!order.genuine) {
      limits.push(`The order is not genuine, though it was read as given: ${order.reasons.join('; ')}.`);
    }
    return {
      commit,
      territory_held: territoryHeld,
      outside,
      results,
      verdict: territoryHeld && results.every((result) => result.outcome === 'passed') ? 'passed' : 'failed',
      limits,
    };
  } finally {
    // Only the folder made above, and only when it lies inside the system's temporary folder.
    const inside = relative(resolve(tmpdir()), resolve(root));
    if (inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)) {
      await rm(root, { recursive: true, force: true });
    }
  }
}

export const HANDLERS = {
  read_order: readOrder,
  check_delivery: (args) => checkDelivery(args),
  explain_receipt: explainReceipt,
};
