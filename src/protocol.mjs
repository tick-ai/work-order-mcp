// MCP over JSON-RPC 2.0, one message at a time, with no I/O of its own:
// `respond(line)` takes a line a client sent and answers the message to send
// back, or null when there is nothing to say. server.mjs carries it over stdio.
//
// Two eras are answered. The current revision, 2026-07-28, is stateless: every
// request names its revision in params._meta, a client probes with
// server/discover, and every result says resultType "complete". The legacy
// handshake (initialize answering 2025-11-25, then the same tools, and ping)
// is answered for clients that open with it.

import { readFileSync } from 'node:fs';
import { HANDLERS } from './handlers.mjs';
import { TOOLS } from './tools.mjs';
import { validate } from './validate.mjs';

export const CURRENT = '2026-07-28';
export const LEGACY = '2025-11-25';
export const SUPPORTED = [CURRENT, LEGACY];

const VERSION_KEY = 'io.modelcontextprotocol/protocolVersion';
const INFO_KEY = 'io.modelcontextprotocol/serverInfo';

const { name, version } = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
export const SERVER_INFO = { name, version };

export const INSTRUCTIONS =
  'Tools for taking a Tick work order correctly. read_order checks that an order is the one its ' +
  'key signed and says what it asks; check_delivery rehearses the order\'s checks on your commit ' +
  'in a temporary copy before you hand the work in; explain_receipt says what a receipt does and ' +
  'does not establish. Whether a key is the buyer\'s is not established here: compare key_id with ' +
  'a key list you hold from elsewhere.';

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;
const UNSUPPORTED_VERSION = -32022;

class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);
const asErrorMessage = (error) => (error instanceof Error ? error.message : String(error));

function failure(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: '2.0', id, error };
}

/** The result of a request in the era it was made in. */
function complete(modern, result) {
  if (!modern) return result;
  return {
    resultType: 'complete',
    ...result,
    _meta: { ...result._meta, [INFO_KEY]: SERVER_INFO },
  };
}

function toolError(message) {
  return { content: [{ type: 'text', text: message }], isError: true };
}

async function callTool(params) {
  if (!isObject(params) || typeof params.name !== 'string') {
    throw new RpcError(INVALID_PARAMS, 'tools/call needs params.name, the name of a tool');
  }
  const tool = TOOLS.find((candidate) => candidate.name === params.name);
  if (!tool) throw new RpcError(INVALID_PARAMS, `Unknown tool: ${params.name}`);

  const args = params.arguments ?? {};
  const problems = validate(tool.inputSchema, args, 'arguments');
  if (problems.length) return toolError(`Invalid arguments for ${tool.name}: ${problems.join('; ')}`);

  const handler = HANDLERS[tool.name];
  if (!handler) {
    return toolError(
      `${tool.name} is not built yet: this server lists it, but nothing answers it, ` +
        'and it will not guess an answer.',
    );
  }
  let structured;
  try {
    structured = await handler(args);
  } catch (error) {
    return toolError(asErrorMessage(error));
  }
  const unmet = validate(tool.outputSchema, structured, 'result');
  if (unmet.length) {
    return toolError(`${tool.name} produced an answer that breaks its outputSchema: ${unmet.join('; ')}`);
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structured,
    isError: false,
  };
}

async function dispatch(request) {
  const { method, params } = request;
  const requested = isObject(params) && isObject(params._meta) ? params._meta[VERSION_KEY] : undefined;

  // initialize and server/discover are how a client learns what is supported,
  // so a revision it names there is not refused.
  if (method !== 'initialize' && method !== 'server/discover') {
    if (requested !== undefined && !SUPPORTED.includes(requested)) {
      throw new RpcError(UNSUPPORTED_VERSION, 'Unsupported protocol version', {
        supported: SUPPORTED,
        requested,
      });
    }
  }
  const modern = requested === CURRENT;

  switch (method) {
    case 'server/discover':
      return {
        resultType: 'complete',
        supportedVersions: SUPPORTED,
        capabilities: { tools: {} },
        instructions: INSTRUCTIONS,
        _meta: { [INFO_KEY]: SERVER_INFO },
      };
    case 'initialize':
      return {
        protocolVersion: LEGACY,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      };
    case 'ping':
      return complete(modern, {});
    case 'tools/list':
      return complete(modern, { tools: TOOLS });
    case 'tools/call':
      return complete(modern, await callTool(params));
    default:
      throw new RpcError(METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** The message to send back for one line a client sent, or null for none. */
export async function respond(line) {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return failure(null, PARSE_ERROR, 'Parse error: the line is not JSON');
  }
  if (!isObject(message) || message.jsonrpc !== '2.0') {
    return failure(null, INVALID_REQUEST, 'Invalid Request: not a JSON-RPC 2.0 message');
  }
  // A response from the client, or a notification: nothing to answer.
  if (typeof message.method !== 'string') {
    return Object.hasOwn(message, 'id') ? null : failure(null, INVALID_REQUEST, 'Invalid Request: no method');
  }
  if (!Object.hasOwn(message, 'id')) return null;
  if (typeof message.id !== 'string' && typeof message.id !== 'number') {
    return failure(null, INVALID_REQUEST, 'Invalid Request: id must be a string or a number');
  }

  try {
    return { jsonrpc: '2.0', id: message.id, result: await dispatch(message) };
  } catch (error) {
    if (error instanceof RpcError) return failure(message.id, error.code, error.message, error.data);
    return failure(message.id, INTERNAL_ERROR, `Internal error: ${asErrorMessage(error)}`);
  }
}
