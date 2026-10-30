import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TOOLS } from '../src/tools.mjs';
import { validate } from '../src/validate.mjs';

test('every schema in src/tools.mjs uses only keywords the validator knows', () => {
  for (const tool of TOOLS) {
    // Throws on a keyword it does not know.
    validate(tool.inputSchema, {}, 'arguments');
    validate(tool.outputSchema, {}, 'result');
  }
});

test('a keyword the validator does not know is refused, not skipped', () => {
  assert.throws(() => validate({ type: 'string', minLength: 3 }, 'ab'), /minLength/);
});

test('type, enum, pattern, minimum, items and nested fields name their place', () => {
  const schema = {
    type: 'object',
    required: ['sha'],
    properties: {
      sha: { type: 'string', pattern: '^[0-9a-f]{4}$' },
      kind: { enum: ['a', 'b'] },
      cost: { type: ['number', 'null'], minimum: 0 },
      names: { type: 'array', items: { type: 'string' } },
      count: { type: 'integer' },
    },
    additionalProperties: false,
  };
  assert.deepEqual(validate(schema, { sha: 'beef', kind: 'a', cost: null, names: ['x'], count: 2 }), []);
  const problems = validate(schema, { sha: 'zz', kind: 'c', cost: -1, names: ['x', 1], count: 1.5, extra: 1 }, 'v');
  assert.equal(problems.length, 6);
  for (const field of ['v.sha', 'v.kind', 'v.cost', 'v.names[1]', 'v.count', 'v.extra']) {
    assert.ok(problems.some((problem) => problem.startsWith(field)), field);
  }
});
