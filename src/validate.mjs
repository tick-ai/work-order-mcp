// A JSON Schema checker for the schemas in src/tools.mjs and no more: the
// keywords those schemas use, and nothing else. A keyword it does not know
// throws, so a schema that grows cannot quietly go unchecked.
//
//   type, enum, pattern, minimum, properties, required, additionalProperties
//   (false only), items, oneOf; and description and title, which say nothing
//   about a value.

const KEYWORDS = new Set([
  'type',
  'enum',
  'pattern',
  'minimum',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'oneOf',
  'description',
  'title',
]);

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function isType(value, type) {
  switch (type) {
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
    case 'boolean':
      return typeof value === type;
    case 'object':
    case 'array':
    case 'null':
      return typeOf(value) === type;
    default:
      throw new Error(`validate: unsupported type ${JSON.stringify(type)}`);
  }
}

function show(value) {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/** The fields an alternative of oneOf asks for, when it asks only for fields. */
function alternativeName(branch) {
  const keys = Object.keys(branch);
  if (keys.length === 1 && keys[0] === 'required') return branch.required.join(' and ');
  return null;
}

/**
 * The ways `value` does not satisfy `schema`, each a sentence that names the
 * place (`path`) and says what to fix. Empty when it does.
 */
export function validate(schema, value, path = 'value') {
  for (const keyword of Object.keys(schema)) {
    if (!KEYWORDS.has(keyword)) throw new Error(`validate: unsupported keyword "${keyword}"`);
  }
  const problems = [];

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((type) => isType(value, type))) {
      problems.push(`${path} must be ${types.join(' or ')}, not ${typeOf(value)}`);
      return problems;
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((option) => option === value)) {
    problems.push(`${path} must be one of ${schema.enum.map(show).join(', ')}, not ${show(value)}`);
  }

  if (typeof value === 'string' && schema.pattern !== undefined) {
    if (!new RegExp(schema.pattern).test(value)) {
      problems.push(`${path} must match ${schema.pattern}, not ${show(value)}`);
    }
  }

  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    problems.push(`${path} must be at least ${schema.minimum}, not ${value}`);
  }

  if (typeOf(value) === 'object') {
    const properties = schema.properties ?? {};
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) problems.push(`${path}.${name} is required`);
    }
    for (const [name, member] of Object.entries(value)) {
      if (Object.hasOwn(properties, name)) {
        problems.push(...validate(properties[name], member, `${path}.${name}`));
      } else if (schema.additionalProperties === false) {
        const known = Object.keys(properties);
        problems.push(
          `${path}.${name} is not a field of this tool` +
            (known.length ? ` (its fields: ${known.join(', ')})` : ''),
        );
      }
    }
  }

  if (typeOf(value) === 'array' && schema.items !== undefined) {
    value.forEach((item, index) => {
      problems.push(...validate(schema.items, item, `${path}[${index}]`));
    });
  }

  if (schema.oneOf !== undefined) {
    const results = schema.oneOf.map((branch) => validate(branch, value, path));
    const holding = results.filter((found) => found.length === 0).length;
    if (holding === 0) {
      problems.push(`${path}: ${results.map((found) => found.join(', ')).join('; or ')}`);
    } else if (holding > 1) {
      const names = schema.oneOf.map(alternativeName);
      problems.push(
        names.every(Boolean)
          ? `${path}: give only one of ${names.join(', ')}`
          : `${path} must satisfy exactly one alternative, and satisfies ${holding}`,
      );
    }
  }

  return problems;
}
