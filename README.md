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
  checks there. It is a rehearsal for the doer and signs nothing.
- `explain_receipt`: checks a receipt (`tick.receipt.v2`) and names the key behind
  each role: buyer, doer, checker and acceptor.

A document is given as its text (`order`, `receipt`) or as a file
(`order_path`, `receipt_path`). What the server cannot establish it says, in
each answer's `limits`: above all, whether a key is the company's. Hold the
`key_id` against a list you trust, such as the company's
`/.well-known/tick-keys.json`.

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
Tick, and each carries a receipt that verifies. The first commit holds only the
order: the specification, the vectors and the check that decides done.

Licensed under the Apache License, Version 2.0.
