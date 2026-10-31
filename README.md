# work-order-mcp

An MCP server an agent runs beside its work, so that it takes a Tick work order
correctly: whether the order is genuine, what it asks, what it may change, what
decides done, and whether its own commit passes before it hands the work in.

It speaks MCP over stdio, the current revision (2026-07-28) and the legacy
handshake both, so that any client of either era can use it. It needs Node 22 or
later and nothing else: no dependency, no build, no network.

## Tools

- `read_order`: checks a work order (`tick.work-order.v1`) as
  [spec/SPEC.md](spec/SPEC.md) does and says what it asks: the instruction, the
  repository and base, the territory, the checks, the budget, the deadline and
  who accepts. When the order is not genuine, it says every reason.
- `check_delivery`: copies the repository at a commit into a temporary folder,
  names the changed files outside the order's territory, and runs the order's
  checks there. It is a rehearsal for the doer and signs nothing. A check whose
  name carries `suite sha256 <64 hex>` is sealed: it is reported `not-run`, the
  verdict leaves it out, and `limits` says passing here says nothing about it.
- `hand_in`: hands a commit in against the order. It refuses an order that is not
  genuine, a commit that does not descend from the order's base and a changed
  file outside the territory; otherwise it writes `delivery.json`
  (`tick.delivery.v1`, signed with the doer's own key) and `work.bundle` (the
  commits since the base) into a folder.
- `explain_receipt`: checks a receipt (`tick.receipt.v2`) and names the key behind
  each role: buyer, doer, checker and acceptor.

A document is given as its text (`order`, `receipt`) or as a file
(`order_path`, `receipt_path`). What the server cannot establish it says, in
each answer's `limits`: above all, whether a key is the company's. Hold the
`key_id` against a list you trust, such as the company's
`/.well-known/tick-keys.json`.

## Hand in without MCP

An agent with no MCP client can hand work in from a shell:

```sh
node hand-in.mjs order.json /path/to/clone <commit> ./handed-in --agent NAME [--model NAME] [--minutes N]
```

It needs Node 22 and git, and nothing else: no Tick, no install, no network. It
prints `handed in <12 characters of the commit> under key <key_id>: <folder>`;
a refusal prints its words to stderr and exits 1, missing arguments print the
usage and exit 2.

The key lives in `$TICK_ID_HOME/id.pem`, or `~/.tick-id/id.pem` when that is not
set: an Ed25519 private key, made once with mode 0600 and reused. The key never
leaves the machine: it is not printed, not returned and not written to the output
folder; only the public key goes into `delivery.json`. Signing proves who handed
the work in, not that it is right: the reader must already hold the `key_id`
from somewhere else, and minutes and agent are the doer's own word.

## Add it

Claude Code, for you:

```sh
claude mcp add --transport stdio tick-work-order -- node /path/to/work-order-mcp/server.mjs
```

or for everyone in a project, in `.mcp.json` at its root, with a time limit long
enough for the order's checks (milliseconds):

```json
{
  "mcpServers": {
    "tick-work-order": {
      "command": "node",
      "args": ["/path/to/work-order-mcp/server.mjs"],
      "timeout": 900000
    }
  }
}
```

Codex:

```sh
codex mcp add tick-work-order -- node /path/to/work-order-mcp/server.mjs
```

or in `~/.codex/config.toml`, where a tool call's time limit is 60 seconds unless
it is raised:

```toml
[mcp_servers.tick-work-order]
command = "node"
args = ["/path/to/work-order-mcp/server.mjs"]
tool_timeout_sec = 900
```

## Checks

`node --test` runs every test; Tick runs the same as this repository's check.

## How it was built

Every commit after this repository's first was made by an AI agent working in
Tick. The first commit holds only the order: the specification, the vectors and
the check that decides done. Three landings have no receipt: f0118650 (the
server), 8c2a7375 (read_order and explain_receipt) and 52502a82
(check_delivery). Their tasks named top-level files in a form Tick could not
sign, so no work order was signed when their work started, and one cannot be
signed after it. They stay in the history, and ticked-line.json draws the line
after them: every landing after 52502a82 carries a receipt that verifies.

Licensed under the Apache License, Version 2.0.
