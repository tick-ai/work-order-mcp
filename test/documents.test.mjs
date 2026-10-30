// read_order and explain_receipt on the vectors: every receipt of version two
// and the work order inside it, every mutant, and a file that is not JSON.

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { HANDLERS } from '../src/handlers.mjs';
import { EXPLAIN_RECEIPT, READ_ORDER } from '../src/tools.mjs';
import { validate } from '../src/validate.mjs';

const VECTORS = new URL('../vectors/', import.meta.url);
const KEY_LIMIT =
  'Whether a key is the company\'s is not established here: hold key_id against a list you trust.';

const list = (folder) => readdirSync(new URL(folder, VECTORS)).sort();
const textOf = (folder, name) => readFileSync(new URL(`${folder}${name}`, VECTORS), 'utf8');
const expected = JSON.parse(readFileSync(new URL('expected.json', VECTORS), 'utf8'));

const receiptsV2 = list('receipts/')
  .map((name) => ({ name, text: textOf('receipts/', name) }))
  .filter(({ text }) => JSON.parse(text).schema === 'tick.receipt.v2');

const readOrder = async (args) => {
  const answer = await HANDLERS.read_order(args);
  assert.deepEqual(validate(READ_ORDER.outputSchema, answer, 'result'), []);
  return answer;
};
const explainReceipt = async (args) => {
  const answer = await HANDLERS.explain_receipt(args);
  assert.deepEqual(validate(EXPLAIN_RECEIPT.outputSchema, answer, 'result'), []);
  return answer;
};

test('the vectors hold receipts of version two and mutants', () => {
  assert.ok(receiptsV2.length > 0);
  assert.ok(list('mutants/').length > 0);
});

test('every work order embedded in a valid receipt of version two reads back genuine with its fields', async () => {
  for (const { name, text } of receiptsV2) {
    const receipt = JSON.parse(text);
    const doc = receipt.receipt.order;
    const answer = await readOrder({ order: JSON.stringify(doc) });
    assert.equal(answer.genuine, true, name);
    assert.deepEqual(answer.reasons, [], name);
    assert.equal(answer.key_id, doc.key_id, name);
    assert.equal(answer.order_id, doc.order_id, name);
    assert.equal(answer.what, doc.order.what, name);
    assert.equal(answer.repository, doc.order.repository, name);
    assert.equal(answer.base, doc.order.base, name);
    assert.deepEqual(answer.territory, doc.order.territory, name);
    assert.deepEqual(answer.checks, doc.order.checks.commands, name);
    assert.equal(answer.budget_usd, doc.order.budget.cap_usd, name);
    assert.equal(answer.deadline, doc.order.deadline, name);
    assert.deepEqual(answer.acceptor, doc.order.acceptor, name);
    assert.deepEqual(answer.from_task, doc.order.from_task, name);
    assert.equal(answer.limits.at(-1), KEY_LIMIT, name);
    assert.ok(answer.limits.length > 1, name);
  }
});

test('a work order given by path reads back as it does given as text', async () => {
  const { name } = receiptsV2[0];
  const doc = JSON.parse(textOf('receipts/', name)).receipt.order;
  const byText = await readOrder({ order: JSON.stringify(doc) });
  const path = join(tmpdir(), `order-${process.pid}.json`);
  const { writeFileSync, rmSync } = await import('node:fs');
  writeFileSync(path, JSON.stringify(doc));
  try {
    assert.deepEqual(await readOrder({ order_path: path }), byText);
  } finally {
    rmSync(path);
  }
});

test('a receipt of version two reads back valid with its four roles', async () => {
  for (const { name, text } of receiptsV2) {
    const receipt = JSON.parse(text);
    const answer = await explainReceipt({ receipt: text });
    assert.equal(answer.kind, 'receipt', name);
    assert.equal(answer.valid, true, name);
    assert.deepEqual(answer.reasons, [], name);
    assert.deepEqual(
      answer.roles,
      {
        buyer: receipt.receipt.order.key_id,
        doer: receipt.receipt.delivery.key_id,
        checker: receipt.receipt.check.key_id,
        acceptor: receipt.key_id,
      },
      name,
    );
    // Roles that share a key, in the order buyer, doer, checker, acceptor.
    const order = ['buyer', 'doer', 'checker', 'acceptor'];
    const groups = [];
    for (const role of order) {
      if (groups.some((group) => group.includes(role))) continue;
      const group = order.filter((other) => answer.roles[other] === answer.roles[role]);
      if (group.length > 1) groups.push(group);
    }
    assert.deepEqual(answer.shared, groups, name);
    assert.equal(answer.limits.at(-1), KEY_LIMIT, name);
    assert.ok(answer.limits.length > 1, name);
  }
});

test('every mutant reads back not valid with exactly the reasons expected.json records', async () => {
  const names = list('mutants/');
  for (const name of names) {
    const record = expected[`mutants/${name}`];
    assert.ok(record, `${name} has no record in expected.json`);
    assert.equal(record.valid, false, name);
    const answer = await explainReceipt({ receipt: textOf('mutants/', name) });
    assert.equal(answer.valid, false, name);
    assert.equal(answer.kind, record.kind, name);
    assert.deepEqual(answer.reasons, record.reasons, name);
    assert.equal(answer.limits.at(-1), KEY_LIMIT, name);
  }
});

test('a mutant is not a genuine work order, with its reasons', async () => {
  for (const name of list('mutants/')) {
    const record = expected[`mutants/${name}`];
    const answer = await readOrder({ order: textOf('mutants/', name) });
    assert.equal(answer.genuine, false, name);
    assert.ok(answer.reasons.length > 0, name);
    if (record.kind !== 'work-order') {
      assert.deepEqual(answer.reasons.slice(0, record.reasons.length), record.reasons, name);
    }
  }
});

test('a work order whose signature is broken is not genuine, and still reads', async () => {
  const doc = JSON.parse(textOf('receipts/', receiptsV2[0].name)).receipt.order;
  doc.signature = Buffer.alloc(64).toString('base64');
  const answer = await readOrder({ order: JSON.stringify(doc) });
  assert.equal(answer.genuine, false);
  assert.deepEqual(answer.reasons, ['the signature is not the carried key’s over this work order']);
  assert.equal(answer.what, doc.order.what);
  assert.equal(answer.order_id, doc.order_id);
  assert.deepEqual(answer.territory, doc.order.territory);
});

test('a work order whose fields cannot be read has null where they cannot', async () => {
  const doc = JSON.parse(textOf('receipts/', receiptsV2[0].name)).receipt.order;
  doc.order = { what: 3, territory: 'x', checks: null, budget: { cap_usd: -1 } };
  const answer = await readOrder({ order: JSON.stringify(doc) });
  assert.equal(answer.genuine, false);
  assert.equal(answer.what, null);
  assert.equal(answer.repository, null);
  assert.equal(answer.base, null);
  assert.deepEqual(answer.territory, []);
  assert.deepEqual(answer.checks, []);
  assert.equal(answer.budget_usd, null);
  assert.equal(answer.deadline, null);
  assert.equal(answer.acceptor, null);
  assert.equal(answer.from_task, null);
});

test('a document that is not JSON answers not genuine with the specification\'s reason', async () => {
  const order = await readOrder({ order: 'this is not JSON' });
  assert.equal(order.genuine, false);
  assert.equal(order.reasons.length, 1);
  assert.match(order.reasons[0], /^it is not JSON: /);
  assert.equal(order.key_id, null);
  assert.equal(order.order_id, null);
  assert.equal(order.what, null);
  assert.deepEqual(order.territory, []);
  assert.deepEqual(order.limits, [KEY_LIMIT]);

  const receipt = await explainReceipt({ receipt: 'this is not JSON' });
  assert.equal(receipt.valid, false);
  assert.equal(receipt.kind, 'unknown');
  assert.equal(receipt.reasons.length, 1);
  assert.match(receipt.reasons[0], /^it is not JSON: /);
  assert.deepEqual(receipt.roles, { buyer: null, doer: null, checker: null, acceptor: null });
  assert.deepEqual(receipt.shared, []);
  assert.deepEqual(receipt.limits, [KEY_LIMIT]);
});

test('a document of another kind is not a work order, nor a receipt of version two', async () => {
  const [receipt] = receiptsV2;
  const asOrder = await readOrder({ order: receipt.text });
  assert.equal(asOrder.genuine, false);
  assert.deepEqual(asOrder.reasons, ['it is a receipt, not a work order']);
  assert.equal(asOrder.what, null);

  const order = JSON.stringify(JSON.parse(receipt.text).receipt.order);
  const asReceipt = await explainReceipt({ receipt: order });
  assert.equal(asReceipt.valid, false);
  assert.equal(asReceipt.kind, 'work-order');
  assert.deepEqual(asReceipt.reasons, ['it is a work-order, not a receipt of version two']);
  assert.deepEqual(asReceipt.roles, { buyer: null, doer: null, checker: null, acceptor: null });
});

test('a document given by a path that cannot be read is an error that says so', async () => {
  const missing = join(tmpdir(), `missing-${process.pid}.json`);
  await assert.rejects(HANDLERS.read_order({ order_path: missing }), /order_path .* cannot be read/);
  await assert.rejects(HANDLERS.explain_receipt({ receipt_path: missing }), /receipt_path .* cannot be read/);
});
