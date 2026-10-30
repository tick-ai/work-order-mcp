// The checker this page uses: verifyDocument(text) answers { kind, valid, reasons,
// limits } for one Tick document, by the rules of spec/SPEC.md, in this browser, with
// Web Crypto and no network. It is written from the specification alone. The same
// file runs in the page and under node --test: it imports nothing.

const encoder = new TextEncoder();

// ---------------------------------------------------------------- the canonical form

/** The canonical form of a JSON value; throws where the value has none. */
export function canonicalSerialize(value) {
  return canon(value, []);
}

function canon(value, path) {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'string':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new Error(`${value} has no canonical form`);
      return JSON.stringify(value);
    case 'object':
      break;
    default:
      throw new Error(`a ${typeof value} has no canonical form`);
  }
  if (path.includes(value)) throw new Error('a structure that contains itself has no canonical form');
  path.push(value);
  let out;
  if (Array.isArray(value)) {
    const parts = [];
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) throw new Error('a hole in an array has no canonical form');
      parts.push(canon(value[i], path));
    }
    out = `[${parts.join(',')}]`;
  } else {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) throw new Error('an object that is not plain has no canonical form');
    const parts = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canon(value[key], path)}`);
    out = `{${parts.join(',')}}`;
  }
  path.pop();
  return out;
}

// ---------------------------------------------------------------- hashes and keys

const hexOf = (buffer) =>
  Array.from(new Uint8Array(buffer), (b) => b.toString(16).padStart(2, '0')).join('');

const sha256Bytes = (bytes) => globalThis.crypto.subtle.digest('SHA-256', bytes);

/** The document hash: SHA-256 of the canonical form written once more as a JSON string. */
export async function documentHash(value) {
  return hexOf(await sha256Bytes(encoder.encode(JSON.stringify(canonicalSerialize(value)))));
}

/** The document hash of a value, or null where it has no canonical form. */
async function hashOrNull(value) {
  try {
    return await documentHash(value);
  } catch {
    return null;
  }
}

function fromBase64(text) {
  if (typeof text !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(text)) return null;
  const bare = text.replace(/=+$/, '');
  if (bare.length % 4 === 1) return null;
  try {
    const binary = atob(bare);
    return Uint8Array.from(binary, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

/** The key_id of a carried key: 16 hex characters of the SHA-256 of its bytes, or null. */
async function keyIdOf(key) {
  const bytes = fromBase64(key);
  if (!bytes) return null;
  return hexOf(await sha256Bytes(bytes)).slice(0, 16);
}

async function signatureHolds(doc, message) {
  const key = fromBase64(doc.key);
  const signature = fromBase64(doc.signature);
  if (!key || !signature) return false;
  try {
    const publicKey = await globalThis.crypto.subtle.importKey('spki', key, { name: 'Ed25519' }, false, ['verify']);
    return await globalThis.crypto.subtle.verify('Ed25519', publicKey, signature, encoder.encode(message));
  } catch {
    return false;
  }
}

/** The key_id and signature steps every signed document ends with. */
async function keyReasons(doc, message, subject) {
  const reasons = [];
  if ((await keyIdOf(doc.key)) !== doc.key_id) reasons.push('key_id is not the carried key’s');
  if (!(await signatureHolds(doc, message))) {
    reasons.push(`the signature is not the carried key’s over this ${subject}`);
  }
  return reasons;
}

/** The hash step: the document hash of `body` equals content_hash. */
async function hashReasons(body, contentHash, name) {
  const hash = await hashOrNull(body);
  if (hash === null) return [`the ${name} cannot be hashed`];
  return hash === contentHash ? [] : [`content_hash is not the hash of the ${name}`];
}

// ---------------------------------------------------------------- shapes

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const nonEmpty = (v) => typeof v === 'string' && v.length > 0;
const isCount = (v) => Number.isInteger(v) && v >= 0;
const isMeasure = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isHex = (v, n) => typeof v === 'string' && v.length === n && /^[0-9a-f]+$/.test(v);
const isStringList = (v) => Array.isArray(v) && v.length > 0 && v.every(nonEmpty);

const daysIn = (year, month) =>
  month === 2 ? (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;

function isDay(year, month, day) {
  return month >= 1 && month <= 12 && day >= 1 && day <= daysIn(year, month);
}

/** YYYY-MM-DDTHH:MM:SS, an optional fraction, then Z or ±HH:MM, on a day that exists. */
function isIsoTime(v) {
  if (typeof v !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(v);
  if (!m) return false;
  const [year, month, day, hour, minute, second] = m.slice(1, 7).map(Number);
  if (!isDay(year, month, day) || hour > 23 || minute > 59 || second > 59) return false;
  return m[7] === undefined || (Number(m[7]) <= 23 && Number(m[8]) <= 59);
}

const isDateString = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** The reasons for the head every signed document has. */
function headReasons(doc, schema, strings) {
  const reasons = [];
  if (doc.schema !== schema) reasons.push(`the schema is ${doc.schema}, not ${schema}`);
  if (doc.alg !== 'ed25519') reasons.push(`the algorithm is ${doc.alg}, not ed25519`);
  if (!isIsoTime(doc.issued_at)) reasons.push('issued_at is not an ISO 8601 time');
  for (const field of strings) if (!nonEmpty(doc[field])) reasons.push(`${field} is not a non-empty string`);
  return reasons;
}

const notObject = (what) => [`it is not ${what}: it is not a JSON object`];

// ---------------------------------------------------------------- limits

const LIMITS = {
  receipt: [
    'The signature proves the holder of the carried key issued this receipt, and content_hash that the ledger was not edited since. It does not prove the coordinator reported the truth.',
    'The carried key is the company’s only if the verifier already holds that key_id from somewhere else. A receipt cannot vouch for its own key.',
    'limits is not covered by the signature: someone who removes it leaves a receipt that still verifies.',
    'This is one task of one run. Work that produced no event is not here.',
  ],
  'audit-export': [
    'content_hash proves this file was not edited after it was written. It proves nothing about whether the coordinator reported the truth — a compromised coordinator produces a self-consistent export.',
    'content_hash covers the ledger only, so that re-exporting an unchanged run gives the same hash. It does not cover this list: someone who removes these limits leaves a document that still verifies.',
    'This is one run. It is not a statement about any other run, and absence of a run from an archive of exports is not evidence that it did not happen.',
    'The ledger records what the coordinator durably observed. Work an agent did that produced no event is not here.',
    'Domain facts are not runtime facts: files modified, tests run, and pull request numbers are not recorded by the coordinator and are not in this document.',
    'A gate decision names the principal the coordinator authenticated. It does not establish that that principal was the right person to decide, because there is no per-gate authorization model.',
  ],
  'audit-trail-export': [
    'content_hash covers every field of this file but itself, and the file is its own canonical form: a byte added, removed or changed anywhere fails verification.',
    'It proves this file was not edited after it was written. It proves nothing about whether the coordinator reported the truth: a compromised coordinator produces a self-consistent export.',
    'It holds what the coordinator’s log held for this month when it was exported; anything recorded for the month afterwards is not in it.',
    'A policy change names the account that started the coordinator with it; the person who asked their agent for it is not recorded.',
    'A network address is the one the coordinator saw at sign-in or enrolment; behind a proxy it is the proxy’s, and events recorded before addresses were are without one.',
  ],
  'usage-report': [
    'The signature proves the holder of the carried key issued this report, and content_hash that its numbers were not edited since. It does not prove the coordinator counted all of its record.',
    'The carried key names one Tick, not a person: reports carrying the same key_id come from the same Tick.',
    'answer is what the person told their Tick; nothing checks it.',
    'Attempts are counted from the usage each worker recorded; an attempt that recorded no containment is in neither count.',
    'limits is not covered by the signature: someone who removes it leaves a report that still verifies.',
  ],
  'work-order': [
    'A work order says what was asked, not that anything was done. The signature proves the holder of the carried key issued it, and content_hash that it was not edited since.',
    'The carried key is the buyer’s only if the verifier already holds that key_id from somewhere else. A work order cannot vouch for its own key.',
    'limits is not covered by the signature: someone who removes it leaves a work order that still verifies.',
    'payment none means no money is held for this order.',
  ],
  delivery: [
    'A delivery says what the doer’s Tick recorded handing in, not that the work is right. The signature proves the holder of the carried key issued it, and content_hash that it was not edited since.',
    'cents marked reported came from the agent’s platform and were not measured.',
    'It does not prove the order exists or that this delivery answers it; that is checked where a receipt binds the two.',
    'The carried key is the doer’s only if the verifier already holds that key_id from somewhere else. A delivery cannot vouch for its own key.',
    'limits is not covered by the signature: someone who removes it leaves a delivery that still verifies.',
  ],
  'check-record': [
    'The checks prove only what they test. A passed record says the pinned commands exited 0 on that tree, not that the work is good.',
    'A test that cannot fail is not detected by this record.',
    'The checker ran them as recorded only as far as the verifier trusts the checker’s key. The signature proves the holder of the carried key issued the record, and content_hash that it was not edited since; the carried key is the checker’s only if the verifier already holds that key_id from somewhere else.',
    'limits is not covered by the signature: someone who removes it leaves a record that still verifies.',
  ],
  'receipt-v2': [
    'A valid receipt says each party’s key signed its own part and the parts chain. It does not say any party told the truth.',
    'The carried keys are the parties’ only if the verifier already holds those key_ids from somewhere else. A receipt cannot vouch for its own keys. When two roles are signed by one key, one holder signed both.',
    'The acceptance names who accepted. The signature proves the acceptor’s key signed the receipt, not that the person named did.',
    'money none means no money is held or paid by this receipt.',
    'limits is not covered by the signature: someone who removes it leaves a receipt that still verifies.',
  ],
  'release-receipt': [
    'A valid release receipt proves the holder of the carried key issued it and that it was not edited since.',
    'It does not prove the key is the company’s. The carried key is the issuer’s only if the verifier already holds that key_id from somewhere else; a receipt cannot vouch for its own key.',
    'It does not prove that the tarball in any registry is the one hashed, or that the release record, the gate’s files or the task receipt are the ones whose hashes it holds: it cannot see them.',
    'It does not prove the release is good.',
    'limits is not covered by the signature: someone who removes it leaves a receipt that still verifies.',
  ],
  'project-statement': [
    'The signature proves the holder of the carried key issued this statement, and content_hash that it was not edited since. It does not prove the coordinator reported the truth.',
    'A try marked reported has the figure the agent’s own platform gave; Tick did not measure it. A try marked unknown has no figure and is counted in tries_unknown, never as zero.',
    'A try that produced no event is not here.',
    'ledger_hash names the run’s full ledger, which this statement does not carry: only someone who holds the ledger can check it.',
    'type and step_of are read from the run’s plan as the coordinator holds it, not from the ledger: ledger_hash does not cover them.',
    'previous is the statement the asker named as the one before; the coordinator keeps no chain of what it issued.',
    'The carried key is the company’s only if the verifier already holds that key_id from somewhere else. A statement cannot vouch for its own key.',
    'limits is not covered by the signature: someone who removes it leaves a statement that still verifies.',
  ],
  'hub-index': [
    'The signature proves the holder of the carried key issued this index, and content_hash that it was not edited since. It does not prove that the statements it names say anything true: each proves only itself.',
    'The carried key is the company’s only if the verifier already holds that key_id from somewhere else, such as the key file on the company’s own website.',
    'An index lists what its publisher chose to publish; a project or a run it leaves out is not shown to be absent.',
    'limits is not covered by the signature: someone who removes it leaves an index that still verifies.',
  ],
  'keys-file': [
    'It is not signed: its authority is the domain that serves it.',
  ],
};

// ---------------------------------------------------------------- tick.receipt.v1

async function checkReceiptV1(doc) {
  if (!isObject(doc)) return { reasons: notObject('a receipt') };
  const reasons = [];
  if (doc.schema !== 'tick.receipt.v1') reasons.push(`the schema is ${doc.schema}, not tick.receipt.v1`);
  if (doc.alg !== 'ed25519') reasons.push(`the algorithm is ${doc.alg}, not ed25519`);
  const ledger = doc.ledger;
  if (!isObject(ledger) || !isObject(ledger.run) || !isObject(ledger.task)) {
    reasons.push('the ledger is missing its run or its task');
    return { reasons };
  }
  reasons.push(...(await hashReasons(ledger, doc.content_hash, 'ledger')));
  if (doc.run_id !== ledger.task.run_id || doc.run_id !== ledger.run.run_id) {
    reasons.push('run_id is not the ledger’s run');
  }
  if (doc.task_id !== ledger.task.task_id) reasons.push('task_id is not the ledger’s task');
  reasons.push(
    ...(await keyReasons(doc, `tick-task-receipt:v1:${doc.run_id}:${doc.task_id}:${doc.content_hash}`, 'receipt')),
  );
  const decisions = ledger.task.gate_decisions;
  const last = Array.isArray(decisions) ? decisions[decisions.length - 1] : undefined;
  const accepted = ledger.task.final_state === 'succeeded' && isObject(last) && last.decision === 'approved';
  return { reasons, accepted };
}

// ---------------------------------------------------------------- the audit exports

async function checkAuditExport(doc) {
  if (!isObject(doc)) return { reasons: notObject('an audit export') };
  const reasons = [];
  if (doc.schema !== 'tick.audit-export.v1') reasons.push(`the schema is ${doc.schema}, not tick.audit-export.v1`);
  reasons.push(...(await hashReasons(doc.ledger, doc.content_hash, 'ledger')));
  return { reasons };
}

async function checkAuditTrailExport(doc, text) {
  if (!isObject(doc) || doc.schema !== 'tick.audit-trail-export.v1') {
    return { reasons: ['it is not an audit trail export (tick.audit-trail-export.v1)'] };
  }
  const { content_hash: contentHash, ...rest } = doc;
  let hash;
  try {
    hash = await documentHash(rest);
  } catch (error) {
    return { reasons: [`it holds a value no export holds: ${error.message}`] };
  }
  if (hash !== contentHash) {
    return {
      reasons: [`its content is not what was exported: content_hash is ${JSON.stringify(contentHash)}, its content hashes to ${hash}`],
    };
  }
  let written;
  try {
    written = `${canonicalSerialize(doc)}\n`;
  } catch {
    written = null;
  }
  if (text !== written) {
    return {
      reasons: [
        'its content matches its hash, but its bytes are not the ones written: spacing, order or line endings were changed',
      ],
    };
  }
  return { reasons: [] };
}

// ---------------------------------------------------------------- tick.usage-report.v1

const NUMBERS_FIELDS = [
  'record_began',
  'first_accepted',
  'accepted_tasks',
  'accepted_days_last_14',
  'attempts_contained',
  'attempts_uncontained',
  'answer',
];

async function checkUsageReport(doc) {
  if (!isObject(doc)) return { reasons: notObject('a usage report') };
  const reasons = [];
  if (doc.schema !== 'tick.usage-report.v1') reasons.push(`the schema is ${doc.schema}, not tick.usage-report.v1`);
  if (doc.alg !== 'ed25519') reasons.push(`the algorithm is ${doc.alg}, not ed25519`);
  const numbers = doc.numbers;
  if (!isObject(numbers)) {
    reasons.push('the report has no numbers');
    return { reasons };
  }
  for (const name of Object.keys(numbers)) {
    if (!NUMBERS_FIELDS.includes(name)) reasons.push(`numbers holds ${name}, which a usage report never carries`);
  }
  for (const name of ['accepted_tasks', 'accepted_days_last_14', 'attempts_contained', 'attempts_uncontained']) {
    if (!isCount(numbers[name])) reasons.push(`numbers.${name} is not a count`);
  }
  for (const name of ['record_began', 'first_accepted']) {
    if (numbers[name] !== null && !isDateString(numbers[name])) reasons.push(`numbers.${name} is neither a time nor null`);
  }
  if (!['very', 'somewhat', 'not', 'none'].includes(numbers.answer)) {
    reasons.push('numbers.answer is not one of very, somewhat, not, none');
  }
  reasons.push(...(await hashReasons(numbers, doc.content_hash, 'numbers')));
  reasons.push(
    ...(await keyReasons(doc, `tick-usage-report:v1:${doc.issued_at}:${doc.content_hash}`, 'report')),
  );
  return { reasons };
}

// ---------------------------------------------------------------- tick.work-order.v1

async function checkWorkOrder(doc) {
  if (!isObject(doc)) return { reasons: notObject('a work order') };
  const reasons = headReasons(doc, 'tick.work-order.v1', ['coordinator', 'order_id']);
  const order = doc.order;
  if (!isObject(order)) {
    reasons.push('order is not an object');
  } else {
    if (!nonEmpty(order.what)) reasons.push('order.what is not a non-empty string');
    if (!nonEmpty(order.repository)) reasons.push('order.repository is not a non-empty string');
    if (!isHex(order.base, 40)) reasons.push('order.base is not 40 lowercase hexadecimal characters');
    if (!isStringList(order.territory)) reasons.push('order.territory is not a non-empty list of non-empty strings');
    const checks = order.checks;
    if (!isObject(checks) || !Array.isArray(checks.commands)) {
      reasons.push('order.checks is not an object holding commands');
    } else {
      if (checks.commands.length === 0) reasons.push('order.checks.commands is not a non-empty list');
      checks.commands.forEach((command, i) => {
        const at = `order.checks.commands[${i}]`;
        if (!isObject(command)) {
          reasons.push(`${at} is not an object`);
          return;
        }
        if (!nonEmpty(command.name)) reasons.push(`${at}.name is not a non-empty string`);
        if (!Array.isArray(command.argv) || command.argv.length === 0 || !command.argv.every((a) => typeof a === 'string')) {
          reasons.push(`${at}.argv is not a non-empty list of strings`);
        }
      });
    }
    if (!isObject(order.budget)) {
      reasons.push('order.budget is not an object');
    } else if (order.budget.cap_usd !== null && !isMeasure(order.budget.cap_usd)) {
      reasons.push('order.budget.cap_usd is not a finite number of zero or more, or null');
    }
    if (order.deadline !== null && !isIsoTime(order.deadline)) reasons.push('order.deadline is not an ISO 8601 time, or null');
    const acceptor = order.acceptor;
    if (!(isObject(acceptor) && ((acceptor.kind === 'person' && nonEmpty(acceptor.name)) || acceptor.kind === 'checks'))) {
      reasons.push('order.acceptor is not { kind: "person", name } or { kind: "checks" }');
    }
    if (!(isObject(order.payment) && order.payment.kind === 'none')) reasons.push('order.payment is not { kind: "none" }');
    const from = order.from_task;
    if (from !== null && !(isObject(from) && nonEmpty(from.run_id) && nonEmpty(from.task_id))) {
      reasons.push('order.from_task is not { run_id, task_id }, or null');
    }
  }
  reasons.push(...(await hashReasons(order, doc.content_hash, 'order')));
  if (isObject(order) && isObject(order.checks)) {
    const hash = await hashOrNull(order.checks);
    if (hash === null) reasons.push('order.checks cannot be hashed');
    else if (hash !== doc.checks_hash) reasons.push('checks_hash is not the hash of order.checks');
  }
  reasons.push(
    ...(await keyReasons(doc, `tick-work-order:v1:${doc.order_id}:${doc.content_hash}`, 'work order')),
  );
  return { reasons };
}

// ---------------------------------------------------------------- tick.delivery.v1

const COSTS = ['metered', 'reported', 'unknown'];

async function checkDelivery(doc) {
  if (!isObject(doc)) return { reasons: notObject('a delivery') };
  const reasons = headReasons(doc, 'tick.delivery.v1', ['coordinator', 'delivery_id']);
  const body = doc.delivery;
  if (!isObject(body)) {
    reasons.push('delivery is not an object');
  } else {
    if (!isHex(body.order_hash, 64)) reasons.push('delivery.order_hash is not 64 lowercase hexadecimal characters');
    if (!nonEmpty(body.repository)) reasons.push('delivery.repository is not a non-empty string');
    for (const name of ['base', 'commit', 'tree']) {
      if (!isHex(body[name], 40)) reasons.push(`delivery.${name} is not 40 lowercase hexadecimal characters`);
    }
    if (!Array.isArray(body.tries) || body.tries.length === 0) {
      reasons.push('delivery.tries is not a non-empty list');
    }
    if (Array.isArray(body.tries)) {
      body.tries.forEach((t, i) => {
        const at = `delivery.tries[${i}]`;
        if (!isObject(t)) {
          reasons.push(`${at} is not an object`);
          return;
        }
        if (!nonEmpty(t.agent)) reasons.push(`${at}.agent is not a non-empty string`);
        if (t.model !== null && typeof t.model !== 'string') reasons.push(`${at}.model is not a string or null`);
        if (t.minutes !== null && !isMeasure(t.minutes)) {
          reasons.push(`${at}.minutes is not a finite number of zero or more, or null`);
        }
        if (t.cents !== null && !isCount(t.cents)) reasons.push(`${at}.cents is not a whole number of zero or more, or null`);
        if (!COSTS.includes(t.cost)) reasons.push(`${at}.cost is not metered, reported or unknown`);
      });
    }
  }
  reasons.push(...(await hashReasons(body, doc.content_hash, 'delivery')));
  reasons.push(
    ...(await keyReasons(doc, `tick-delivery:v1:${doc.delivery_id}:${doc.content_hash}`, 'delivery')),
  );
  return { reasons };
}

// ---------------------------------------------------------------- tick.check-record.v1

const OUTCOMES = ['passed', 'failed', 'not-run'];

async function checkCheckRecord(doc) {
  if (!isObject(doc)) return { reasons: notObject('a check record') };
  const reasons = headReasons(doc, 'tick.check-record.v1', ['coordinator', 'record_id']);
  const body = doc.record;
  if (!isObject(body)) {
    reasons.push('record is not an object');
  } else {
    for (const name of ['order_hash', 'checks_hash']) {
      if (!isHex(body[name], 64)) reasons.push(`record.${name} is not 64 lowercase hexadecimal characters`);
    }
    if (!nonEmpty(body.repository)) reasons.push('record.repository is not a non-empty string');
    for (const name of ['base', 'commit', 'tree']) {
      if (!isHex(body[name], 40)) reasons.push(`record.${name} is not 40 lowercase hexadecimal characters`);
    }
    if (typeof body.territory_held !== 'boolean') reasons.push('record.territory_held is not true or false');
    if (!Array.isArray(body.results) || body.results.length === 0) reasons.push('record.results is not a non-empty list');
    if (Array.isArray(body.results)) {
      body.results.forEach((r, i) => {
        const at = `record.results[${i}]`;
        if (!isObject(r)) {
          reasons.push(`${at} is not an object`);
          return;
        }
        if (!nonEmpty(r.name)) reasons.push(`${at}.name is not a non-empty string`);
        if (r.exit_code !== null && !Number.isInteger(r.exit_code)) reasons.push(`${at}.exit_code is not a whole number or null`);
        if (!OUTCOMES.includes(r.outcome)) reasons.push(`${at}.outcome is not passed, failed or not-run`);
        if (r.duration_ms !== null && !isCount(r.duration_ms)) {
          reasons.push(`${at}.duration_ms is not a whole number of zero or more, or null`);
        }
      });
    }
    if (!['container', 'none'].includes(body.contained)) reasons.push('record.contained is not container or none');
    if (!['passed', 'failed'].includes(body.verdict)) reasons.push('record.verdict is not passed or failed');

    const results = body.results;
    if (
      typeof body.territory_held === 'boolean' &&
      Array.isArray(results) &&
      results.every((r) => isObject(r) && OUTCOMES.includes(r.outcome))
    ) {
      const allPassed = results.every((r) => r.outcome === 'passed');
      if (body.verdict === 'passed' && body.territory_held === false) {
        reasons.push('record.verdict is passed, but record.territory_held is false');
      }
      if (body.verdict === 'passed' && !allPassed) {
        reasons.push('record.verdict is passed, but a result in record.results is not passed');
      }
      if (body.verdict === 'failed' && body.territory_held === true && allPassed) {
        reasons.push('record.verdict is failed, but the territory was held and every result passed');
      }
    }
  }
  reasons.push(...(await hashReasons(body, doc.content_hash, 'record')));
  reasons.push(
    ...(await keyReasons(doc, `tick-check-record:v1:${doc.record_id}:${doc.content_hash}`, 'check record')),
  );
  return { reasons };
}

// ---------------------------------------------------------------- tick.release-receipt.v1

const RELEASE_FIELDS = [
  'version',
  'gated',
  'base',
  'commit',
  'tarball',
  'tarball_sha256',
  'shasum',
  'pushed',
  'record_sha256',
  'gate_check_sha256',
  'gate_summary_sha256',
  'task_receipt_hash',
];

const isVersion = (v) =>
  typeof v === 'string' && v.length <= 64 && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(v);

async function checkReleaseReceipt(doc) {
  if (!isObject(doc)) return { reasons: notObject('a release receipt') };
  const reasons = headReasons(doc, 'tick.release-receipt.v1', ['coordinator', 'run_id', 'task_id']);
  const body = doc.release;
  if (!isObject(body)) {
    reasons.push('release is not an object');
  } else {
    if (!isVersion(body.version)) {
      reasons.push(
        'release.version is not three dot-separated numbers and an optional - or + suffix of letters, digits, dots and hyphens, in at most 64 characters',
      );
    }
    const hex40 = (name) => {
      if (!isHex(body[name], 40)) reasons.push(`release.${name} is not 40 lowercase hexadecimal characters`);
    };
    const hex64 = (name) => {
      if (!isHex(body[name], 64)) reasons.push(`release.${name} is not 64 lowercase hexadecimal characters`);
    };
    hex40('gated');
    if (body.base !== null && !isHex(body.base, 40)) reasons.push('release.base is not 40 lowercase hexadecimal characters or null');
    hex40('commit');
    if (!nonEmpty(body.tarball)) reasons.push('release.tarball is not a non-empty string');
    hex64('tarball_sha256');
    hex40('shasum');
    if (!isStringList(body.pushed)) reasons.push('release.pushed is not a non-empty list of non-empty strings');
    hex64('record_sha256');
    hex64('gate_check_sha256');
    hex64('gate_summary_sha256');
    hex64('task_receipt_hash');
    for (const name of Object.keys(body)) {
      if (!RELEASE_FIELDS.includes(name)) reasons.push(`release.${name} is not a field of a release`);
    }
  }
  reasons.push(...(await hashReasons(body, doc.content_hash, 'release')));
  reasons.push(
    ...(await keyReasons(
      doc,
      `tick-release-receipt:v1:${doc.run_id}:${doc.task_id}:${doc.content_hash}`,
      'release receipt',
    )),
  );
  return { reasons };
}

/**
 * Held against what a reader was offered: one reason for each of version, commit,
 * tarball_sha256, record_sha256, run_id and task_id that differs. The signature is not looked at.
 */
export function releaseReceiptDisagreements(doc, offered) {
  if (!isObject(doc) || !isObject(doc.release)) return ['it is not a release receipt with a release'];
  const held = { ...doc.release, run_id: doc.run_id, task_id: doc.task_id };
  const reasons = [];
  for (const field of ['version', 'commit', 'tarball_sha256', 'record_sha256', 'run_id', 'task_id']) {
    if (held[field] !== offered[field]) reasons.push(`${field} is ${held[field]}, not the ${offered[field]} offered`);
  }
  return reasons;
}

// ---------------------------------------------------------------- tick.receipt.v2

async function checkReceiptV2(doc) {
  if (!isObject(doc)) return { reasons: notObject('a receipt') };
  const reasons = headReasons(doc, 'tick.receipt.v2', ['coordinator', 'receipt_id']);
  const body = doc.receipt;
  if (!isObject(body)) {
    reasons.push('receipt is not an object');
  } else {
    const acceptance = body.acceptance;
    if (!isObject(acceptance)) {
      reasons.push('receipt.acceptance is not an object');
    } else {
      if (!['person', 'auto-tick', 'checks'].includes(acceptance.by)) {
        reasons.push('receipt.acceptance.by is not person, auto-tick or checks');
      }
      if (!nonEmpty(acceptance.who)) reasons.push('receipt.acceptance.who is not a non-empty string');
      if (!isIsoTime(acceptance.at)) reasons.push('receipt.acceptance.at is not an ISO 8601 time');
    }
    if (!(isObject(body.money) && body.money.kind === 'none')) reasons.push('receipt.money is not { kind: "none" }');
  }

  const parts = isObject(body) ? body : {};
  const embedded = [
    ['order', checkWorkOrder],
    ['delivery', checkDelivery],
    ['check', checkCheckRecord],
  ];
  for (const [role, check] of embedded) {
    const result = await check(parts[role]);
    for (const reason of result.reasons) reasons.push(`${role}: ${reason}`);
  }

  const { order, delivery, check } = parts;
  const same = (a, b, reason) => {
    if (a !== b) reasons.push(reason);
  };
  const field = (doc2, key, name) => (isObject(doc2) && isObject(doc2[key]) ? doc2[key][name] : undefined);
  if (isObject(order) && isObject(delivery)) {
    same(field(delivery, 'delivery', 'order_hash'), order.content_hash, 'the delivery’s order_hash is not the order’s content_hash');
    same(field(delivery, 'delivery', 'base'), field(order, 'order', 'base'), 'the delivery’s base is not the order’s');
  }
  if (isObject(order) && isObject(check)) {
    same(field(check, 'record', 'order_hash'), order.content_hash, 'the check’s order_hash is not the order’s content_hash');
    same(field(check, 'record', 'checks_hash'), order.checks_hash, 'the check’s checks_hash is not the order’s checks_hash');
  }
  if (isObject(delivery) && isObject(check)) {
    for (const name of ['repository', 'base', 'commit', 'tree']) {
      same(field(check, 'record', name), field(delivery, 'delivery', name), `the check’s ${name} is not the delivery’s`);
    }
  }
  if (isObject(order) && isObject(body) && isObject(body.acceptance)) {
    const { by, who } = body.acceptance;
    const acceptor = field(order, 'order', 'acceptor');
    const kind = isObject(acceptor) ? acceptor.kind : undefined;
    if (by === 'checks') {
      if (kind !== 'checks') reasons.push('the acceptance is by checks, but the order’s acceptor is not checks');
    } else if (by === 'person' || by === 'auto-tick') {
      const how = by === 'person' ? 'a person' : 'auto tick';
      if (kind !== 'person') {
        reasons.push(`the acceptance is by ${how}, but the order’s acceptor is not a person`);
      } else if (who !== acceptor.name) {
        reasons.push(
          by === 'person'
            ? 'the acceptance is by a person the order does not name'
            : 'the acceptance is by auto tick for a person the order does not name',
        );
      }
    }
  }
  if (isObject(check) && field(check, 'record', 'verdict') === 'failed') {
    reasons.push('the receipt accepts a check whose verdict is failed');
  }

  reasons.push(...(await hashReasons(body, doc.content_hash, 'receipt')));
  reasons.push(
    ...(await keyReasons(doc, `tick-receipt:v2:${doc.receipt_id}:${doc.content_hash}`, 'receipt')),
  );

  const signers = {};
  for (const [role, d] of [['buyer', order], ['doer', delivery], ['checker', check], ['acceptor', doc]]) {
    signers[role] = isObject(d) ? await keyIdOf(d.key) : null;
  }
  const shared = [];
  const seen = new Set();
  for (const role of Object.keys(signers)) {
    if (signers[role] === null || seen.has(role)) continue;
    const group = Object.keys(signers).filter((r) => signers[r] === signers[role]);
    group.forEach((r) => seen.add(r));
    if (group.length > 1) shared.push(group);
  }
  return { reasons, signers, shared };
}

// ---------------------------------------------------------------- tick.project-receipt.v2

const STATEMENT_TOTALS = ['tries', 'tries_unknown', 'usd_micros_reported', 'usd_micros_metered'];

async function checkProjectStatement(doc) {
  if (!isObject(doc)) return { reasons: notObject('a project statement') };
  const reasons = headReasons(doc, 'tick.project-receipt.v2', ['coordinator', 'run_id']);
  const body = doc.statement;
  if (!isObject(body)) {
    reasons.push('statement is not an object');
  } else {
    if (!isObject(body.run) || !nonEmpty(body.run.run_id)) {
      reasons.push('statement.run is not an object holding a run_id');
    } else if (body.run.run_id !== doc.run_id) {
      reasons.push('run_id is not the statement’s run');
    }
    const tasksStart = reasons.length;
    if (!Array.isArray(body.tasks)) {
      reasons.push('statement.tasks is not a list');
    } else {
      const ids = body.tasks.map((t) => (isObject(t) ? t.task_id : undefined));
      body.tasks.forEach((task, i) => {
        const at = `statement.tasks[${i}]`;
        if (!isObject(task)) {
          reasons.push(`${at} is not an object`);
          return;
        }
        if (!nonEmpty(task.task_id)) reasons.push(`${at}.task_id is not a non-empty string`);
        if (!nonEmpty(task.type)) reasons.push(`${at}.type is not a non-empty string`);
        if (task.step_of !== null && !(nonEmpty(task.step_of) && task.step_of !== task.task_id && ids.includes(task.step_of))) {
          reasons.push(`${at}.step_of is not the task_id of another task of the statement, or null`);
        }
        for (const name of ['final_state', 'disposition']) {
          if (task[name] !== null && typeof task[name] !== 'string') reasons.push(`${at}.${name} is not a string or null`);
        }
        if (task.receipt !== null && !isHex(task.receipt, 64)) {
          reasons.push(`${at}.receipt is not 64 lowercase hexadecimal characters, or null`);
        }
        if (!Array.isArray(task.tries)) {
          reasons.push(`${at}.tries is not a list`);
        } else {
          task.tries.forEach((t, j) => {
            const here = `${at}.tries[${j}]`;
            if (!isObject(t)) {
              reasons.push(`${here} is not an object`);
              return;
            }
            for (const name of ['attempt_id', 'agent', 'outcome']) {
              if (!nonEmpty(t[name])) reasons.push(`${here}.${name} is not a non-empty string`);
            }
            if (t.model !== null && typeof t.model !== 'string') reasons.push(`${here}.model is not a string or null`);
            if (t.minutes !== null && !isMeasure(t.minutes)) {
              reasons.push(`${here}.minutes is not a finite number of zero or more, or null`);
            }
            if (t.usd_micros !== null && !isCount(t.usd_micros)) {
              reasons.push(`${here}.usd_micros is not a whole number of zero or more, or null`);
            }
            if (!COSTS.includes(t.cost)) {
              reasons.push(`${here}.cost is not metered, reported or unknown`);
            } else if (t.cost === 'unknown') {
              if (t.usd_micros !== null) reasons.push(`${here}.cost is unknown, but its usd_micros is not null`);
            } else if (t.usd_micros === null) {
              reasons.push(`${here}.usd_micros is null, but its cost is ${t.cost}`);
            }
          });
        }
      });
    }
    const shaped = Array.isArray(body.tasks) && reasons.length === tasksStart;
    const totals = body.totals;
    if (!isObject(totals)) {
      reasons.push('statement.totals is not an object');
    } else {
      for (const name of STATEMENT_TOTALS) {
        if (!isCount(totals[name])) reasons.push(`statement.totals.${name} is not a whole number of zero or more`);
      }
    }
    if (body.previous !== null && !isHex(body.previous, 64)) {
      reasons.push('statement.previous is not 64 lowercase hexadecimal characters, or null');
    }
    if (!isHex(body.ledger_hash, 64)) reasons.push('statement.ledger_hash is not 64 lowercase hexadecimal characters');

    if (shaped && isObject(totals)) {
      const tries = body.tasks.flatMap((t) => t.tries);
      const sums = {
        tries: BigInt(tries.length),
        tries_unknown: BigInt(tries.filter((t) => t.cost === 'unknown').length),
        usd_micros_reported: tries.filter((t) => t.cost === 'reported').reduce((s, t) => s + BigInt(t.usd_micros), 0n),
        usd_micros_metered: tries.filter((t) => t.cost === 'metered').reduce((s, t) => s + BigInt(t.usd_micros), 0n),
      };
      const limit = 2n ** 53n;
      let inexact = false;
      for (const name of STATEMENT_TOTALS) {
        if (sums[name] > limit) {
          inexact = true;
        } else if (totals[name] !== Number(sums[name])) {
          reasons.push(`statement.totals.${name} is not the sum of the tries`);
        }
      }
      if (inexact) reasons.push('statement.totals cannot be added up exactly: a sum passes 2^53');
    }
  }
  reasons.push(...(await hashReasons(body, doc.content_hash, 'statement')));
  reasons.push(
    ...(await keyReasons(doc, `tick-project-receipt:v2:${doc.run_id}:${doc.content_hash}`, 'statement')),
  );
  return { reasons };
}

// ---------------------------------------------------------------- tick.hub-index.v1

async function checkHubIndex(doc) {
  if (!isObject(doc)) return { reasons: notObject('a hub index') };
  const reasons = headReasons(doc, 'tick.hub-index.v1', ['coordinator']);
  const body = doc.index;
  if (!isObject(body)) {
    reasons.push('index is not an object');
  } else {
    if (!nonEmpty(body.publisher)) reasons.push('index.publisher is not a non-empty string');
    if (body.previous !== null && !isHex(body.previous, 64)) {
      reasons.push('index.previous is not 64 lowercase hexadecimal characters, or null');
    }
    if (!Array.isArray(body.projects)) {
      reasons.push('index.projects is not a list');
    } else {
      body.projects.forEach((project, i) => {
        const at = `index.projects[${i}]`;
        if (!isObject(project)) {
          reasons.push(`${at} is not an object`);
          return;
        }
        if (typeof project.slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.slug)) {
          reasons.push(`${at}.slug is not lowercase letters and digits joined by single hyphens`);
        }
        if (!nonEmpty(project.name)) reasons.push(`${at}.name is not a non-empty string`);
        if (!nonEmpty(project.repository)) reasons.push(`${at}.repository is not a non-empty string`);
        if (!Array.isArray(project.runs) || project.runs.length === 0) {
          reasons.push(`${at}.runs is not a non-empty list`);
          return;
        }
        const ids = project.runs.map((r) => (isObject(r) ? r.run_id : undefined)).filter(nonEmpty);
        if (new Set(ids).size !== ids.length) reasons.push(`${at}.runs names one run twice`);
        project.runs.forEach((run, j) => {
          const here = `${at}.runs[${j}]`;
          if (!isObject(run)) {
            reasons.push(`${here} is not an object`);
            return;
          }
          if (!nonEmpty(run.run_id)) reasons.push(`${here}.run_id is not a non-empty string`);
          const statements = run.statements;
          if (!Array.isArray(statements) || statements.length === 0 || !statements.every((s) => isHex(s, 64))) {
            reasons.push(`${here}.statements is not a non-empty list of 64 lowercase hexadecimal characters each`);
          }
          if (Array.isArray(statements) && statements.length > 0) {
            if (new Set(statements).size !== statements.length) reasons.push(`${here}.statements names one statement twice`);
            if (run.head !== statements[statements.length - 1]) reasons.push(`${here}.head is not the newest of its statements`);
          }
        });
      });
      const slugs = body.projects.map((p) => (isObject(p) ? p.slug : undefined)).filter((s) => typeof s === 'string');
      if (new Set(slugs).size !== slugs.length) {
        reasons.push('index.projects names one slug twice');
      } else if (slugs.some((s, i) => i > 0 && !(slugs[i - 1] < s))) {
        reasons.push('index.projects is not sorted by slug');
      }
    }
  }
  reasons.push(...(await hashReasons(body, doc.content_hash, 'index')));
  reasons.push(...(await keyReasons(doc, `tick-hub-index:v1:${doc.content_hash}`, 'index')));
  return { reasons };
}

// ---------------------------------------------------------------- tick-keys/1

async function checkKeysFile(doc) {
  if (!isObject(doc)) return { reasons: notObject('a keys file') };
  const reasons = [];
  if (doc.schema !== 'tick-keys/1') reasons.push(`the schema is ${doc.schema}, not tick-keys/1`);
  if (!Array.isArray(doc.keys) || doc.keys.length === 0) {
    reasons.push('keys is not a non-empty list');
    return { reasons };
  }
  doc.keys.forEach((key, i) => {
    const at = `keys[${i}]`;
    if (!isObject(key)) {
      reasons.push(`${at} is not an object`);
      return;
    }
    if (!isHex(key.key_id, 16)) reasons.push(`${at}.key_id is not 16 lowercase hexadecimal characters`);
    if (!['coordinator', 'release'].includes(key.role)) reasons.push(`${at}.role is not coordinator or release`);
    const day = typeof key.from === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(key.from) : null;
    if (!day || !isDay(Number(day[1]), Number(day[2]), Number(day[3]))) {
      reasons.push(`${at}.from is not a day, YYYY-MM-DD`);
    }
  });
  const ids = doc.keys.map((k) => (isObject(k) ? k.key_id : undefined)).filter((id) => typeof id === 'string');
  if (new Set(ids).size !== ids.length) reasons.push('keys names one key_id twice');
  return { reasons };
}

// ---------------------------------------------------------------- verifyDocument

const KINDS = new Map([
  ['tick.receipt.v1', ['receipt', checkReceiptV1, 'receipt']],
  ['tick.audit-export.v1', ['audit-export', checkAuditExport, 'audit-export']],
  ['tick.audit-trail-export.v1', ['audit-trail-export', checkAuditTrailExport, 'audit-trail-export']],
  ['tick.usage-report.v1', ['usage-report', checkUsageReport, 'usage-report']],
  ['tick.work-order.v1', ['work-order', checkWorkOrder, 'work-order']],
  ['tick.delivery.v1', ['delivery', checkDelivery, 'delivery']],
  ['tick.check-record.v1', ['check-record', checkCheckRecord, 'check-record']],
  ['tick.receipt.v2', ['receipt', checkReceiptV2, 'receipt-v2']],
  ['tick.release-receipt.v1', ['release-receipt', checkReleaseReceipt, 'release-receipt']],
  ['tick.project-receipt.v2', ['project-statement', checkProjectStatement, 'project-statement']],
  ['tick.hub-index.v1', ['hub-index', checkHubIndex, 'hub-index']],
  ['tick-keys/1', ['keys-file', checkKeysFile, 'keys-file']],
]);

const unknown = (reason) => ({ kind: 'unknown', valid: false, reasons: [reason], limits: [] });

/** Checks one document's text by its `schema`; never throws. */
export async function verifyDocument(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    return unknown(`it is not JSON: ${error.message}`);
  }
  if (!isObject(doc)) return unknown('it is not a Tick document: it is not a JSON object');
  const entry = typeof doc.schema === 'string' ? KINDS.get(doc.schema) : undefined;
  if (!entry) {
    const written = doc.schema === undefined ? 'null' : JSON.stringify(doc.schema);
    return unknown(`the schema is ${written}, which this verifier does not know`);
  }
  const [kind, check, limitsKey] = entry;
  let result;
  try {
    result = await check(doc, text);
  } catch (error) {
    result = { reasons: [`the document could not be checked: ${error.message}`] };
  }
  const { reasons, ...rest } = result;
  return { kind, valid: reasons.length === 0, reasons, limits: LIMITS[limitsKey], ...rest };
}
