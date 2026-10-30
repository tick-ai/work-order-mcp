// The server's tool surface: what an agent may ask and what it is answered.
// The server (server.mjs) lists these as they are and validates every call's
// arguments against them; each answer it returns conforms to the outputSchema
// (MCP 2026-07-28, server/tools: a tool with an outputSchema MUST return
// structuredContent that conforms). Field words follow spec/SPEC.md.

const hex40 = { type: 'string', pattern: '^[0-9a-f]{40}$' };
const strings = { type: 'array', items: { type: 'string' } };
const keyIdOrNull = { type: ['string', 'null'], pattern: '^[0-9a-f]{16}$' };

/** A document given as its text or as a file's path (`<name>_path`), never both. */
function documentInput(name, what) {
  return {
    type: 'object',
    properties: {
      [name]: { type: 'string', description: `The ${what}'s JSON text.` },
      [`${name}_path`]: {
        type: 'string',
        description: `The path of a file holding the ${what}, instead of its text.`,
      },
    },
    oneOf: [{ required: [name] }, { required: [`${name}_path`] }],
  };
}

const orderInput = documentInput('order', 'work order (tick.work-order.v1)');

export const READ_ORDER = {
  name: 'read_order',
  title: 'Read a work order',
  description:
    'Checks a Tick work order (tick.work-order.v1) as spec/SPEC.md does and says what it asks: ' +
    'the instruction, the repository and base, the territory the doer may change, the checks that ' +
    'decide done, the budget, the deadline and who accepts. genuine is true only when the order is ' +
    'the one its key signed; when it is false, reasons says every way it is not, and the fields ' +
    'read are still given so the refusal can name them. Whether the key is the buyer\'s is not ' +
    'established here: compare key_id with a key list held from elsewhere.',
  inputSchema: { ...orderInput, additionalProperties: false },
  outputSchema: {
    type: 'object',
    required: ['genuine', 'reasons', 'key_id', 'order_id', 'limits'],
    additionalProperties: false,
    properties: {
      genuine: { type: 'boolean' },
      reasons: strings,
      key_id: keyIdOrNull,
      order_id: { type: ['string', 'null'] },
      what: { type: ['string', 'null'] },
      repository: { type: ['string', 'null'] },
      base: { ...hex40, type: ['string', 'null'] },
      territory: strings,
      checks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'argv'],
          additionalProperties: false,
          properties: { name: { type: 'string' }, argv: strings },
        },
      },
      budget_usd: { type: ['number', 'null'], minimum: 0 },
      deadline: { type: ['string', 'null'] },
      acceptor: { type: ['object', 'null'] },
      from_task: { type: ['object', 'null'] },
      limits: strings,
    },
  },
};

export const CHECK_DELIVERY = {
  name: 'check_delivery',
  title: 'Rehearse the checks on a commit',
  description:
    'Before handing work in: copies the repository at the commit into a temporary folder (never the ' +
    'checkout it names), lists the files the commit changes from the order\'s base and any outside ' +
    'its territory, and runs each of the order\'s checks there with a time limit. A rehearsal for ' +
    'the doer, not a check record: it signs nothing, and Tick\'s own check of the delivery decides.',
  inputSchema: {
    ...orderInput,
    properties: {
      ...orderInput.properties,
      repository: {
        type: 'string',
        description: 'The path of a local clone that holds the commit.',
      },
      commit: {
        type: 'string',
        description: 'The commit to check: its 40-character sha, or a name git resolves in the clone.',
      },
    },
    required: ['repository', 'commit'],
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    required: ['commit', 'territory_held', 'outside', 'results', 'verdict', 'limits'],
    additionalProperties: false,
    properties: {
      commit: hex40,
      territory_held: { type: 'boolean' },
      outside: strings,
      results: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'outcome', 'exit_code', 'duration_ms'],
          additionalProperties: false,
          properties: {
            name: { type: 'string' },
            outcome: { enum: ['passed', 'failed', 'not-run'] },
            exit_code: { type: ['integer', 'null'] },
            duration_ms: { type: 'integer', minimum: 0 },
            output_tail: { type: 'string' },
          },
        },
      },
      verdict: { enum: ['passed', 'failed'] },
      limits: strings,
    },
  },
};

const role = keyIdOrNull;

export const EXPLAIN_RECEIPT = {
  name: 'explain_receipt',
  title: 'Explain a receipt',
  description:
    'Checks a receipt of version two (tick.receipt.v2) as spec/SPEC.md does: whether each party\'s ' +
    'key signed its own part and the parts chain, every reason it does not, the key_id behind each ' +
    'role (buyer, doer, checker, acceptor), the roles that share one key, and what the receipt says ' +
    'it does not establish. It cannot say whether any party told the truth.',
  inputSchema: {
    ...documentInput('receipt', 'receipt (tick.receipt.v2)'),
    additionalProperties: false,
  },
  outputSchema: {
    type: 'object',
    required: ['kind', 'valid', 'reasons', 'roles', 'shared', 'limits'],
    additionalProperties: false,
    properties: {
      kind: { type: 'string' },
      valid: { type: 'boolean' },
      reasons: strings,
      roles: {
        type: 'object',
        required: ['buyer', 'doer', 'checker', 'acceptor'],
        additionalProperties: false,
        properties: { buyer: role, doer: role, checker: role, acceptor: role },
      },
      shared: { type: 'array', items: strings },
      limits: strings,
    },
  },
};

export const TOOLS = [READ_ORDER, CHECK_DELIVERY, EXPLAIN_RECEIPT];
