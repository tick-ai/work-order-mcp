# Design

What this server is for: an agent on any platform takes a Tick work order and
hands in work against it. Tick's own agents learn the order from Tick; an agent
elsewhere learns it from the order itself, a signed document
([spec/SPEC.md](../spec/SPEC.md), `tick.work-order.v1`). This server reads that
document for the agent, checks it was not changed after its key signed it, and
lets the agent rehearse the order's checks on its own commit before it hands the
work in. The work order and the receipt are the shared language; MCP carries
them to whatever agent the doer runs.

## Tools

The surface is `src/tools.mjs`: each tool's name, description, input schema and
output schema, which the server lists as they are and holds every call and
answer to.

1. `read_order` takes `order` (the order's JSON text) or `order_path`, and
   answers `genuine`, every reason it is not, and the fields read: `key_id`,
   `order_id`, `what`, `repository`, `base`, `territory`, `checks`,
   `budget_usd`, `deadline`, `acceptor`, `from_task`, and the order's `limits`.
   An order that is not genuine still has its fields read, so an agent can say
   what it refuses.
2. `check_delivery` takes the order as above, `repository` (a local clone) and
   `commit`. It copies the repository at the commit into a temporary folder,
   never the checkout it was given, and checks that folder's path is not empty
   before any command takes it. The files the commit changes from the order's
   `base` that lie outside `territory` are named in `outside`. Each of the
   order's checks runs there with a time limit, and `verdict` is `passed` only
   when the territory held and every check passed. It signs nothing: Tick's own
   check of the delivery decides. A check whose name carries
   `suite sha256 <64 hex>` is sealed: the suite's files are not in the doer's
   tree, so it is not run but reported `not-run`, the verdict leaves it out, and
   `limits` says how many are sealed and that passing here says nothing about them.
3. `explain_receipt` takes `receipt` or `receipt_path` and answers the verdict
   on a receipt of version two: `valid`, every reason, the `key_id` behind each
   role (buyer, doer, checker, acceptor), the groups of roles that share a key,
   and the receipt's `limits`.
4. `hand_in` takes the order as above, `repository`, `commit`, `out`, `agent` and
   optionally `model` and `minutes`, for an agent with nothing installed but Node
   and git (`hand-in.mjs` is the same for a shell). It refuses, writing nothing,
   an order that is not genuine, a commit the order's `base` is not an ancestor
   of, and a changed file outside `territory`. Otherwise it writes, into `out`,
   `delivery.json` (`tick.delivery.v1`, signed with the doer's own Ed25519 key,
   made once in `$TICK_ID_HOME` or `~/.tick-id` and never printed, returned or
   written to `out`) and `work.bundle` (the commits since the base), and checks
   the delivery with the verifier before it answers. The signature proves who
   handed the work in, not that it is right.

## Protocol

MCP's current revision is 2026-07-28, and it is stateless: every request names
its revision in `params._meta["io.modelcontextprotocol/protocolVersion"]`, a
server must answer `server/discover`, and a revision it does not support is the
error -32022, "Unsupported protocol version", with `data` naming the supported
and the requested ones. Revisions up to 2025-11-25 are legacy: a client opens
with `initialize`. A client probes a stdio server with `server/discover` and
falls back to `initialize` on any other answer. Claude Code runs either era,
depending on its version and its settings, and Codex's documentation names no
revision. So this server answers both:

- modern: `server/discover`, `tools/list` and `tools/call`, each result with
  `resultType: "complete"`;
- legacy: `initialize` (answering 2025-11-25), then `tools/list`, `tools/call`
  and `ping`.

A tool's answer is `structuredContent` that conforms to its output schema, and
the same JSON as a text block for older clients. A bad argument, such as a
missing order, a file that cannot be read, or a commit the clone does not hold,
is a tool execution error (`isError: true`) whose words say what to fix; an
unknown tool is the protocol error -32602.

How the two eras are told apart, and what is answered where:

- `server/discover` answers `resultType: "complete"`, `supportedVersions`
  (2026-07-28 and 2025-11-25), `capabilities` (`{ tools: {} }`), `instructions`,
  and `_meta["io.modelcontextprotocol/serverInfo"]` (`{ name, version }`, the
  package's own). It, like `initialize`, is answered whatever revision the
  request names, since it is how a client learns what is supported.
- Any other request that names a revision other than the two supported gets
  -32022 with `data: { supported, requested }`. A request that names 2026-07-28
  gets `resultType: "complete"` and the same `serverInfo` in its result's
  `_meta`. A request that names no revision is a legacy request, and its result
  is the plain legacy shape.
- `initialize` answers protocol version 2025-11-25 whatever the client offered,
  with `capabilities`, `serverInfo` and `instructions`; the client decides
  whether it can speak that. Notifications, such as `notifications/initialized`,
  get no answer. Legacy requests are not refused for coming before `initialize`.
- A line that is not JSON is -32700, a JSON line that is not a JSON-RPC 2.0
  request is -32600, an unknown method is -32601.
- `tools/list` gives the tools of `src/tools.mjs` as they are. `tools/call`
  checks `arguments` against the tool's `inputSchema` with `src/validate.mjs`,
  which knows only the JSON Schema keywords those schemas use and throws on any
  other, so a schema that grows cannot go quietly unchecked. A failure is a tool
  execution error whose words name the field (`arguments.commit is required`).
  An answer is also held to the `outputSchema` before it is sent.
- Each tool's working part is an entry in `src/handlers.mjs`. A tool with no
  entry answers a tool execution error saying it is not built yet; it never
  answers a verdict it did not reach.

What the revision's pages do not settle here: this was written without access
to the documentation, so the exact shape of `server/discover` beyond the fields
above, whether `ping` carries `resultType` in the current revision, and whether
`initialize` may be refused when the client offers a revision this server does
not speak are taken from the task's description and left as stated above, not
confirmed against the pages. Re-check these when the documentation can be
reached.

Over stdio, one message per line with no newline inside it, nothing on standard
output that is not a message, logs on standard error, and the server exits when
its input ends.

## Choices

- No dependency at all. Tick checks this repository on a machine with nothing
  installed, and a tool that tells an agent whether an order is genuine should
  carry no code the reader has to trust besides its own.
- Its verifier is the one TickHub's page runs in the browser, copied at a named
  commit of that repository, so the same checks answer in the page and here.
- The specification is the authority on every document and every reason.
  Where this server and spec/SPEC.md disagree, the server is wrong.

## Checks

`node --test`: every order in `vectors/` reads back genuine with its fields;
every mutant that changes an order reads back not genuine with the
specification's reason; `check_delivery` runs over a fixture repository with a
bare origin, both made in a temporary folder; and the stdio exchange is driven
in both eras by a test that starts the server as a client would.
