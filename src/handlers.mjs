// The tools' working parts, by tool name: each takes the arguments the tool's
// inputSchema has already accepted and answers what its outputSchema describes,
// or throws an Error whose message says what to fix (a tool execution error).
// A tool with no entry here is not built yet.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

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

export const HANDLERS = { read_order: readOrder, explain_receipt: explainReceipt };
