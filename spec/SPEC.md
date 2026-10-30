# Tick receipts and exports: the format, and how to check one offline

This is the specification `@tick-executor/verify` is written from. It describes
the documents Tick writes, the one form they are hashed in, and exactly what a
check of each proves. Anyone can write a verifier from it, in any language; this
package is one, under the Apache License 2.0, and it needs nothing of Tick's.

A check reads the document and nothing else. It makes no network call and asks no
one. It cannot tell whether what a document says is true. It tells you whether
the document is the one that was written, and, for a receipt, who signed it.

Every document names its kind in a `schema` field, and a verdict names the
document by the kind in the third column:

| Document                     | `schema`                     | kind                 |
| ---------------------------- | ---------------------------- | -------------------- |
| A task receipt               | `tick.receipt.v1`            | `receipt`            |
| One run's audit export       | `tick.audit-export.v1`       | `audit-export`       |
| A month's audit trail export | `tick.audit-trail-export.v1` | `audit-trail-export` |
| A member's usage report      | `tick.usage-report.v1`       | `usage-report`       |
| A work order                 | `tick.work-order.v1`         | `work-order`         |
| A delivery                   | `tick.delivery.v1`           | `delivery`           |
| A check record               | `tick.check-record.v1`       | `check-record`       |
| A receipt, version two       | `tick.receipt.v2`            | `receipt`            |
| A release receipt            | `tick.release-receipt.v1`    | `release-receipt`    |
| A project's statement        | `tick.project-receipt.v2`    | `project-statement`  |
| A company's index            | `tick.hub-index.v1`          | `hub-index`          |
| A company's keys             | `tick-keys/1`                | `keys-file`          |

A check refuses a document whose `schema` is not the one it expects. A file that
is no document of the table is of kind `unknown`, invalid, with one reason and no
limits, and is not guessed at:

- A file that is not JSON: `it is not JSON: <the parser's own message>`. The
  message after the colon is the parser's, so it differs from one language to
  the next; a reader compares only what comes before it.
- JSON that is not an object: `it is not a Tick document: it is not a JSON object`.
- An object whose `schema` is not in the table:
  `the schema is <the schema>, which this verifier does not know`, the schema
  written as `JSON.stringify` writes it, and `null` where the field is missing.

## The canonical form

A JSON value is written as one string:

- `null` is `null`, and a boolean is `true` or `false`.
- A string is written as `JSON.stringify` writes it: in double quotes, with the
  JSON escapes, and every other character as it is.
- A number must be finite, and is written as `JSON.stringify` writes it: the
  ECMA-262 number-to-string algorithm, the same digits for the same double in
  every engine. Negative zero is written `0`.
- An array is `[`, its elements in their order separated by `,`, and `]`. Order
  is part of the value and is never sorted.
- An object is `{`, its entries separated by `,`, and `}`. Each entry is the key
  written as a string, `:`, and the value. Entries are sorted by key, comparing
  UTF-16 code units, so the order keys were inserted in changes nothing.
- There is no whitespace anywhere outside strings.

A value no JSON document holds has no canonical form, and a check that meets one
fails: `undefined` (also as an array element), `NaN`, `Infinity`, a function, a
bigint, a symbol, an object that is not plain (a date, a map, a class instance),
and a structure that contains itself.

## The document hash

Every document's `content_hash` is the **document hash** of the part of it that
the document says it covers. It is taken in two steps, and the second is easy to
miss:

1. Write the value in its canonical form, `C`, above.
2. Write `C` itself as a JSON string, with `JSON.stringify`: in double quotes,
   with a backslash before every double quote and backslash inside it. The
   document hash is the SHA-256 of the UTF-8 bytes of that, as 64 lowercase
   hexadecimal characters.

So for the value `{"a":1}`, `C` is `{"a":1}`, the bytes hashed are
`"{\"a\":1}"` (eleven characters, the quotes included), and the document hash
is `3dc4eef510cec9eda1ca361042e8152bd62c44288af2d9cc465cc217c381facd`. A hash
of `C` alone, `015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862`
for the same value, is **not** what any Tick document holds: a verifier that
took it would reject every receipt and export Tick has written. Tick's own
writers reach the second step by hashing the canonical string as a value, and
the documents already written have that hash, so the form is fixed.

## A task receipt, `tick.receipt.v1`

One accepted task, signed.

| Field               | Holds                                                                                          |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `schema`            | `tick.receipt.v1`                                                                              |
| `alg`               | `ed25519`                                                                                      |
| `issued_at`         | When it was issued, as an ISO 8601 time                                                        |
| `coordinator`       | The coordinator it was read from                                                               |
| `run_id`, `task_id` | The run and the task                                                                           |
| `ledger`            | `{ run, task }`: the run's header and the task's entry, as the coordinator's ledger holds them |
| `content_hash`      | The document hash of `ledger`                                                                  |
| `key`               | The verifying key: an Ed25519 public key as SPKI DER, in base64                                |
| `key_id`            | The first 16 hexadecimal characters of the SHA-256 of the SPKI DER bytes                       |
| `signature`         | An Ed25519 signature, in base64                                                                |
| `limits`            | What the document does not establish, in words                                                 |

**What is signed.** The UTF-8 bytes of this string, with the three values filled
in: `tick-task-receipt:v1:<run_id>:<task_id>:<content_hash>`. The signature is
over those bytes themselves, with no pre-hashing. The label `tick-task-receipt:v1`
is carried by no other signature Tick makes, so a signature made for anything
else can never pass as a receipt's, or the reverse.

**The check.** Every failure below is reported, so a reader sees all that is
wrong and not only the first. A receipt is valid when none of them applies.

1. `schema` is `tick.receipt.v1`. If not: `the schema is <schema>, not tick.receipt.v1`.
2. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
3. `ledger` holds a `run` and a `task`. If not, the check stops with
   `the ledger is missing its run or its task`.
4. The document hash of `ledger` equals `content_hash`. If the ledger cannot be
   hashed: `the ledger cannot be hashed`. If it differs:
   `content_hash is not the hash of the ledger`.
5. `run_id` equals the task's `run_id` and the run's `run_id`. If not:
   `run_id is not the ledger’s run`. `task_id` equals the task's `task_id`. If
   not: `task_id is not the ledger’s task`.
6. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
7. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this receipt`.

**Whether the task was accepted** is read from the ledger and from nothing the
issuer wrote beside it: the task's `final_state` is `succeeded` and the last
entry of its `gate_decisions` has `decision` `approved`. A receipt can be valid
and say the task was not accepted.

What the document says it does not establish:

- The signature proves the holder of the carried key issued this receipt, and content_hash that the ledger was not edited since. It does not prove the coordinator reported the truth.
- The carried key is the company’s only if the verifier already holds that key_id from somewhere else. A receipt cannot vouch for its own key.
- limits is not covered by the signature: someone who removes it leaves a receipt that still verifies.
- This is one task of one run. Work that produced no event is not here.

## One run's audit export, `tick.audit-export.v1`

| Field          | Holds                                                    |
| -------------- | -------------------------------------------------------- |
| `schema`       | `tick.audit-export.v1`                                   |
| `exported_at`  | When the export was taken, not when the run happened     |
| `coordinator`  | The coordinator it was read from                         |
| `exported_by`  | The principal that read it                               |
| `run_id`       | The run                                                  |
| `ledger`       | The run's ledger, verbatim                               |
| `content_hash` | The document hash of `ledger` alone, not of the envelope |
| `limits`       | What the document does not establish, in words           |

**The check.** The document hash of `ledger` equals `content_hash`. A different
`schema` is a failure of its own. The hash covers the ledger alone, so
re-exporting an unchanged run gives the same hash, and a change to
`exported_at`, `exported_by` or `coordinator` does not break it.

What the document says it does not establish:

- content_hash proves this file was not edited after it was written. It proves nothing about whether the coordinator reported the truth — a compromised coordinator produces a self-consistent export.
- content_hash covers the ledger only, so that re-exporting an unchanged run gives the same hash. It does not cover this list: someone who removes these limits leaves a document that still verifies.
- This is one run. It is not a statement about any other run, and absence of a run from an archive of exports is not evidence that it did not happen.
- The ledger records what the coordinator durably observed. Work an agent did that produced no event is not here.
- Domain facts are not runtime facts: files modified, tests run, and pull request numbers are not recorded by the coordinator and are not in this document.
- A gate decision names the principal the coordinator authenticated. It does not establish that that principal was the right person to decide, because there is no per-gate authorization model.

## A month's audit trail export, `tick.audit-trail-export.v1`

| Field                                       | Holds                                                  |
| ------------------------------------------- | ------------------------------------------------------ |
| `schema`                                    | `tick.audit-trail-export.v1`                           |
| `month`                                     | The month, as `YYYY-MM`                                |
| `exported_at`, `coordinator`, `exported_by` | As for a run's export                                  |
| `trail`                                     | The month's audit trail, verbatim                      |
| `limits`                                    | What the document does not establish, in words         |
| `content_hash`                              | The document hash of every other field of the document |

This one is stricter. The file is the canonical form of the document followed by
one newline (`\n`), and the check asks for exactly those bytes.

**The check.** Read the file's text as JSON; fail with `it is not JSON: …` if it
is not. It must be an object whose `schema` is `tick.audit-trail-export.v1`;
otherwise `it is not an audit trail export (tick.audit-trail-export.v1)`. Remove
`content_hash` and take the document hash of what is left. If the document holds
a value with no canonical form, fail with `it holds a value no export holds: …`.
If the hash differs from `content_hash`, fail with
`its content is not what was exported`, giving both. If the hash matches but the
file's text is not the canonical form of the whole document plus one newline,
fail with `its content matches its hash, but its bytes are not the ones written:
spacing, order or line endings were changed`.

What the document says it does not establish:

- content_hash covers every field of this file but itself, and the file is its own canonical form: a byte added, removed or changed anywhere fails verification.
- It proves this file was not edited after it was written. It proves nothing about whether the coordinator reported the truth: a compromised coordinator produces a self-consistent export.
- It holds what the coordinator's log held for this month when it was exported; anything recorded for the month afterwards is not in it.
- A policy change names the account that started the coordinator with it; the person who asked their agent for it is not recorded.
- A network address is the one the coordinator saw at sign-in or enrolment; behind a proxy it is the proxy's, and events recorded before addresses were are without one.

## A member's usage report, `tick.usage-report.v1`

What a member may send the founders about their own use of Tick, signed by the
member's coordinator: a few numbers and the person's one answer, never a run, a
task, a file, a repository, a branch, a person or a prompt.

- `schema`: `tick.usage-report.v1`
- `alg`: `ed25519`
- `issued_at`: When it was issued, as an ISO 8601 time
- `numbers`: The signed body, below, and nothing else
- `content_hash`: The document hash of `numbers`
- `key`, `key_id`, `signature`, `limits`: As for a task receipt

The body, `numbers`, holds exactly these fields:

- `record_began`: When the record's first event happened, a time, or `null` for an empty record
- `first_accepted`: When the first work that is still accepted was accepted, a time, or `null`
- `accepted_tasks`: How many tasks' last acceptance decision is an approval
- `accepted_days_last_14`: On how many distinct UTC days, within the 14 days before the report, such work was accepted
- `attempts_contained`: How many recorded attempts ran in a container or the agent's sandbox
- `attempts_uncontained`: How many recorded attempts ran with no containment
- `answer`: The person's answer to "How would you feel if you could no longer use Tick?": `very`, `somewhat` or `not`, or `none` where they have not answered

The four counts are whole numbers of zero or more.

**What is signed.** The UTF-8 bytes of this string, with the two values filled
in: `tick-usage-report:v1:<issued_at>:<content_hash>`, `issued_at` exactly as
the document carries it. The signature is over those bytes themselves, with no
pre-hashing. The label `tick-usage-report:v1` is carried by no other signature
Tick makes.

**The check.** Every failure below is reported, except where it says the check
stops. A report is valid when none of them applies.

1. The document is a JSON object. If not: `it is not a usage report: it is not a JSON object`, and the check stops.
2. `schema` is `tick.usage-report.v1`. If not: `the schema is <schema>, not tick.usage-report.v1`.
3. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
4. `numbers` is an object. If not: `the report has no numbers`, and the check
   stops with that reason and those before it.
5. The numbers, one reason for each that is wrong, in this order:
   - each field of `numbers` that is not one of the seven above: `numbers holds <name>, which a usage report never carries`
   - each of `accepted_tasks`, `accepted_days_last_14`, `attempts_contained` and `attempts_uncontained`, in that order, that is not a whole number of zero or more: `numbers.<name> is not a count`
   - each of `record_began` and `first_accepted`, in that order, that is neither `null` nor a time: `numbers.<name> is neither a time nor null`
   - `answer` that is not one of the four: `numbers.answer is not one of very, somewhat, not, none`
6. The document hash of `numbers` equals `content_hash`. If the numbers cannot be
   hashed: `the numbers cannot be hashed`. If it differs:
   `content_hash is not the hash of the numbers`.
7. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
8. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this report`.

**What counts as a time here.** This package takes a string as a time when
JavaScript's `Date.parse` reads it, which is looser than ISO 8601, and it does not
check the form of `issued_at` at all: `issued_at` matters only as the signed
bytes carry it. Tick writes every time in a report as an ISO 8601 time in UTC
(`2026-10-20T09:00:00.000Z`), so a verifier in another language takes a time to
be an ISO 8601 date and time; on a report Tick wrote the two agree.

What the document says it does not establish:

- The signature proves the holder of the carried key issued this report, and content_hash that its numbers were not edited since. It does not prove the coordinator counted all of its record.
- The carried key names one Tick, not a person: reports carrying the same key_id come from the same Tick.
- answer is what the person told their Tick; nothing checks it.
- Attempts are counted from the usage each worker recorded; an attempt that recorded no containment is in neither count.
- limits is not covered by the signature: someone who removes it leaves a report that still verifies.

## A work order, `tick.work-order.v1`

What a buyer asks for, signed by the buyer's coordinator before work starts. It
has a task receipt's canonical form, document hash, key, `key_id`, `signature`
and `limits`.

- `schema`: `tick.work-order.v1`
- `alg`: `ed25519`
- `issued_at`: When it was issued, as an ISO 8601 time
- `coordinator`: The coordinator it was read from
- `order_id`: The order, a non-empty string
- `order`: The signed body, below
- `checks_hash`: The document hash of `order.checks`, so a record of a check run can name the checks it ran
- `content_hash`: The document hash of `order`
- `key`: The verifying key: an Ed25519 public key as SPKI DER, in base64
- `key_id`: The first 16 hexadecimal characters of the SHA-256 of the SPKI DER bytes
- `signature`: An Ed25519 signature, in base64
- `limits`: What the document does not establish, in words

The body, `order`:

- `what`: The instruction: a non-empty string
- `repository`: Where the work lands: a non-empty string
- `base`: The commit the work starts from: 40 lowercase hexadecimal characters
- `territory`: The paths the doer may change, as Tick's territory writes them: a non-empty list of non-empty strings
- `checks`: `{ commands }`: a non-empty list of `{ name, argv }`, `name` a non-empty string and `argv` a non-empty list of strings. They decide done and are run from the delivered tree. Every file outside `territory` is the buyer's, so the doer cannot change them
- `budget`: `{ cap_usd }`: a finite number of zero or more, or `null`
- `deadline`: An ISO 8601 time, or `null`
- `acceptor`: `{ kind: "person", name }` with a non-empty `name`, or `{ kind: "checks" }`. A Tick coordinator signs a task's order with the company's owner as it holds the owner, the account id (`<issuer>:<subject>`) its `--owners` names, as `name`; an order signed by an earlier release names the runner identity of the window that started the run. The check below needs only that `name` is the one the acceptance names
- `payment`: `{ kind: "none" }`: no money is held for this order
- `from_task`: `{ run_id, task_id }`, both non-empty strings: the Tick task it was made from; or `null`

An ISO 8601 time here is `YYYY-MM-DDTHH:MM:SS`, optionally followed by a decimal
fraction, then `Z` or `±HH:MM`, naming a day that exists.

**What is signed.** The UTF-8 bytes of this string, with the two values filled
in: `tick-work-order:v1:<order_id>:<content_hash>`. The signature is over those
bytes themselves, with no pre-hashing. The label `tick-work-order:v1` is carried
by no other signature Tick makes.

**`alg` names one algorithm.** A later version of this document may carry a
second signature beside the first, such as a post-quantum one (TN4.5). A verifier
refuses an `alg` it does not know, and does not guess at the rest.

**The check.** Every failure below is reported, so a reader sees all that is
wrong and not only the first. A work order is valid when none of them applies.

1. `schema` is `tick.work-order.v1`. If not: `the schema is <schema>, not tick.work-order.v1`.
2. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
3. `issued_at` is an ISO 8601 time. If not: `issued_at is not an ISO 8601 time`.
   `coordinator` and `order_id` are non-empty strings. If not:
   `<field> is not a non-empty string`.
4. `order` is an object. If not: `order is not an object`. Then each field of
   the body, one reason for each that is missing or of the wrong shape:
   - `order.what is not a non-empty string`, and the same for `order.repository`
   - `order.base is not 40 lowercase hexadecimal characters`
   - `order.territory is not a non-empty list of non-empty strings`
   - `order.checks is not an object holding commands`;
     `order.checks.commands is not a non-empty list`; and for the command at
     index `i`: `order.checks.commands[i] is not an object`,
     `order.checks.commands[i].name is not a non-empty string`,
     `order.checks.commands[i].argv is not a non-empty list of strings`
   - `order.budget is not an object`;
     `order.budget.cap_usd is not a finite number of zero or more, or null`
   - `order.deadline is not an ISO 8601 time, or null`
   - `order.acceptor is not { kind: "person", name } or { kind: "checks" }`
   - `order.payment is not { kind: "none" }`
   - `order.from_task is not { run_id, task_id }, or null`
5. The document hash of `order` equals `content_hash`. If the order cannot be
   hashed: `the order cannot be hashed`. If it differs:
   `content_hash is not the hash of the order`.
6. The document hash of `order.checks` equals `checks_hash`. If it differs:
   `checks_hash is not the hash of order.checks`. If it cannot be hashed:
   `order.checks cannot be hashed`. This is skipped when `order.checks` is not an
   object, which step 4 has already reported.
7. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
8. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this work order`.

What the document says it does not establish:

- A work order says what was asked, not that anything was done. The signature proves the holder of the carried key issued it, and content_hash that it was not edited since.
- The carried key is the buyer’s only if the verifier already holds that key_id from somewhere else. A work order cannot vouch for its own key.
- limits is not covered by the signature: someone who removes it leaves a work order that still verifies.
- payment none means no money is held for this order.

## A delivery, `tick.delivery.v1`

What the doer hands in, signed by the doer's coordinator. It has a task receipt's
canonical form, document hash, key, `key_id`, `signature` and `limits`.

- `schema`: `tick.delivery.v1`
- `alg`: `ed25519`
- `issued_at`, `coordinator`: As for a work order
- `delivery_id`: The delivery, a non-empty string
- `delivery`: The signed body, below
- `content_hash`: The document hash of `delivery`
- `key`, `key_id`, `signature`, `limits`: As for a work order

The body, `delivery`:

- `order_hash`: The work order's `content_hash`: 64 lowercase hexadecimal characters
- `repository`: Where the work landed: a non-empty string
- `base`: The commit the work started from: 40 lowercase hexadecimal characters
- `commit`: The delivered commit: 40 lowercase hexadecimal characters
- `tree`: The delivered commit's git tree: 40 lowercase hexadecimal characters
- `tries`: A non-empty list of `{ agent, model, minutes, cents, cost }`: `agent` a non-empty string; `model` a string or `null`; `minutes` a finite number of zero or more, or `null`; `cents` a whole number of zero or more, or `null`; `cost` one of `metered`, `reported` or `unknown`. The `agent` `unknown` means the attempt's agent was never reported.

**What is signed.** The UTF-8 bytes of this string, with the two values filled
in: `tick-delivery:v1:<delivery_id>:<content_hash>`. The signature is over those
bytes themselves, with no pre-hashing. The label `tick-delivery:v1` is carried by
no other signature Tick makes, so a signature made for a work order, a receipt or
anything else can never pass as a delivery's, or the reverse.

**`alg` names one algorithm.** A later version may carry a second signature
beside the first, such as a post-quantum one (TN4.5). A verifier refuses an `alg`
it does not know.

**The check.** Every failure below is reported, so a reader sees all that is
wrong and not only the first. A delivery is valid when none of them applies.

1. `schema` is `tick.delivery.v1`. If not: `the schema is <schema>, not tick.delivery.v1`.
2. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
3. `issued_at` is an ISO 8601 time. If not: `issued_at is not an ISO 8601 time`.
   `coordinator` and `delivery_id` are non-empty strings. If not:
   `<field> is not a non-empty string`.
4. `delivery` is an object. If not: `delivery is not an object`. Then each field
   of the body, one reason for each that is missing or of the wrong shape:
   - `delivery.order_hash is not 64 lowercase hexadecimal characters`
   - `delivery.repository is not a non-empty string`
   - `delivery.base is not 40 lowercase hexadecimal characters`, and the same for
     `delivery.commit` and `delivery.tree`
   - `delivery.tries is not a non-empty list`; and for the try at index `i`:
     `delivery.tries[i] is not an object`,
     `delivery.tries[i].agent is not a non-empty string`,
     `delivery.tries[i].model is not a string or null`,
     `delivery.tries[i].minutes is not a finite number of zero or more, or null`,
     `delivery.tries[i].cents is not a whole number of zero or more, or null`,
     `delivery.tries[i].cost is not metered, reported or unknown`
5. The document hash of `delivery` equals `content_hash`. If the delivery cannot
   be hashed: `the delivery cannot be hashed`. If it differs:
   `content_hash is not the hash of the delivery`.
6. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
7. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this delivery`.

What the document says it does not establish:

- A delivery says what the doer’s Tick recorded handing in, not that the work is right. The signature proves the holder of the carried key issued it, and content_hash that it was not edited since.
- cents marked reported came from the agent’s platform and were not measured.
- It does not prove the order exists or that this delivery answers it; that is checked where a receipt binds the two.
- The carried key is the doer’s only if the verifier already holds that key_id from somewhere else. A delivery cannot vouch for its own key.
- limits is not covered by the signature: someone who removes it leaves a delivery that still verifies.

## A check record, `tick.check-record.v1`

What a checker found, signed by the checker's coordinator. It has a task
receipt's canonical form, document hash, key, `key_id`, `signature` and `limits`.

- `schema`: `tick.check-record.v1`
- `alg`: `ed25519`
- `issued_at`, `coordinator`: As for a work order
- `record_id`: The record, a non-empty string
- `record`: The signed body, below
- `content_hash`: The document hash of `record`
- `key`, `key_id`, `signature`, `limits`: As for a work order

The body, `record`:

- `order_hash`: The work order's `content_hash`: 64 lowercase hexadecimal characters
- `checks_hash`: The work order's `checks_hash`: 64 lowercase hexadecimal characters
- `repository`: Where the work landed: a non-empty string
- `base`: The commit the work started from: 40 lowercase hexadecimal characters
- `commit`: The delivered commit: 40 lowercase hexadecimal characters
- `tree`: The delivered commit's git tree: 40 lowercase hexadecimal characters
- `territory_held`: `true` when every path changed from `base` to `commit` lies inside the order's `territory`, otherwise `false`
- `results`: A non-empty list, in the order's command order, of `{ name, exit_code, outcome, duration_ms }`: `name` a non-empty string; `exit_code` a whole number or `null`, where `null` means that no exit code was recorded, which is the case both when the command did not run to an exit (the `outcome` is then `not-run`) and when the check's verdict was recorded without its exit code (the `outcome` is then `passed` or `failed`), and `0` is written only where an exit code of 0 was recorded; `outcome` one of `passed`, `failed` or `not-run`, and it, not `exit_code`, says whether the command passed; `duration_ms` a whole number of zero or more, or `null`
- `contained`: `container` or `none`: whether the commands ran in a container
- `verdict`: `passed` or `failed`

**What is signed.** The UTF-8 bytes of this string, with the two values filled
in: `tick-check-record:v1:<record_id>:<content_hash>`. The signature is over those
bytes themselves, with no pre-hashing. The label `tick-check-record:v1` is
carried by no other signature Tick makes, so a signature made for a work order, a
delivery, a receipt or anything else can never pass as a check record's, or the
reverse.

**`alg` names one algorithm.** A later version may carry a second signature
beside the first, such as a post-quantum one (TN4.5). A verifier refuses an `alg`
it does not know.

**The check.** Every failure below is reported, so a reader sees all that is
wrong and not only the first. A check record is valid when none of them applies.

1. `schema` is `tick.check-record.v1`. If not: `the schema is <schema>, not tick.check-record.v1`.
2. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
3. `issued_at` is an ISO 8601 time. If not: `issued_at is not an ISO 8601 time`.
   `coordinator` and `record_id` are non-empty strings. If not:
   `<field> is not a non-empty string`.
4. `record` is an object. If not: `record is not an object`. Then each field of
   the body, one reason for each that is missing or of the wrong shape:
   - `record.order_hash is not 64 lowercase hexadecimal characters`, and the same for `record.checks_hash`
   - `record.repository is not a non-empty string`
   - `record.base is not 40 lowercase hexadecimal characters`, and the same for
     `record.commit` and `record.tree`
   - `record.territory_held is not true or false`
   - `record.results is not a non-empty list`; and for the result at index `i`:
     `record.results[i] is not an object`,
     `record.results[i].name is not a non-empty string`,
     `record.results[i].exit_code is not a whole number or null`,
     `record.results[i].outcome is not passed, failed or not-run`,
     `record.results[i].duration_ms is not a whole number of zero or more, or null`
   - `record.contained is not container or none`
   - `record.verdict is not passed or failed`
5. The verdict does not contradict what it is a verdict on. This is checked when
   `territory_held` is true or false and every result has one of the three
   outcomes, and each way it fails is its own reason:
   - the verdict is `passed` and `territory_held` is `false`:
     `record.verdict is passed, but record.territory_held is false`
   - the verdict is `passed` and a result is not `passed`:
     `record.verdict is passed, but a result in record.results is not passed`
   - the verdict is `failed`, `territory_held` is `true` and every result is
     `passed`:
     `record.verdict is failed, but the territory was held and every result passed`
6. The document hash of `record` equals `content_hash`. If the record cannot be
   hashed: `the record cannot be hashed`. If it differs:
   `content_hash is not the hash of the record`.
7. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
8. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this check record`.

What the document says it does not establish:

- The checks prove only what they test. A passed record says the pinned commands exited 0 on that tree, not that the work is good.
- A test that cannot fail is not detected by this record.
- The checker ran them as recorded only as far as the verifier trusts the checker’s key. The signature proves the holder of the carried key issued the record, and content_hash that it was not edited since; the carried key is the checker’s only if the verifier already holds that key_id from somewhere else.
- limits is not covered by the signature: someone who removes it leaves a record that still verifies.

## A release receipt, `tick.release-receipt.v1`

What a release made, signed by the coordinator that made it. It has a task
receipt's canonical form, document hash, key, `key_id` and `signature`, and
may carry `limits`.

- `schema`: `tick.release-receipt.v1`
- `alg`: `ed25519`
- `issued_at`, `coordinator`: As for a work order
- `run_id`, `task_id`: The run and the task that made the release, non-empty strings
- `release`: The signed body, below
- `content_hash`: The document hash of `release`
- `key`, `key_id`, `signature`, `limits`: As for a work order

The body, `release`, has exactly these fields and no other:

- `version`: Three dot-separated numbers, then optionally `-` or `+` and a suffix of `0-9A-Za-z.-`; at most 64 characters, no whitespace
- `gated`: The commit the gate passed: 40 lowercase hexadecimal characters
- `base`: The commit the release started from: 40 lowercase hexadecimal characters, or `null` for a first release
- `commit`: The release commit: 40 lowercase hexadecimal characters
- `tarball`: The tarball's file name: a non-empty string
- `tarball_sha256`: The SHA-256 of the tarball's bytes: 64 lowercase hexadecimal characters
- `shasum`: The SHA-1 the registry holds for the tarball: 40 lowercase hexadecimal characters
- `pushed`: Where the release was pushed: a non-empty list of non-empty strings
- `record_sha256`: The SHA-256 of the bytes of the signed release record, `releases/<version>.json`: 64 lowercase hexadecimal characters
- `gate_check_sha256`: The SHA-256 of the gate's `check.json`: 64 lowercase hexadecimal characters
- `gate_summary_sha256`: The SHA-256 of the gate's summary: 64 lowercase hexadecimal characters
- `task_receipt_hash`: The `content_hash` of this task's ledger, `{run, task}`: 64 lowercase hexadecimal characters. It equals the `content_hash` of the `tick.receipt.v1` of this same run and task when such a receipt exists; a release task has no gate of its own, so one may not

**What is signed.** The UTF-8 bytes of this string, with the three values filled
in: `tick-release-receipt:v1:<run_id>:<task_id>:<content_hash>`. The signature is
over those bytes themselves, with no pre-hashing. The label
`tick-release-receipt:v1` is carried by no other signature Tick makes, so a
signature made for a delivery, a receipt or anything else can never pass as a
release receipt's, or the reverse.

**`alg` names one algorithm.** A verifier refuses an `alg` it does not know.

**The check.** Every failure below is reported, so a reader sees all that is
wrong and not only the first. A release receipt is valid when none of them
applies.

0. If the document is not a JSON object: `it is not a release receipt: it is not a JSON object`, and nothing else is checked.
1. `schema` is `tick.release-receipt.v1`. If not: `the schema is <schema>, not tick.release-receipt.v1`.
2. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
3. `issued_at` is an ISO 8601 time. If not: `issued_at is not an ISO 8601 time`.
   `coordinator`, `run_id` and `task_id` are non-empty strings. If not:
   `<field> is not a non-empty string`.
4. `release` is an object. If not: `release is not an object`. Then each field
   of the body, in the order above, one reason for each that is missing or of the
   wrong shape:
   - `release.version is not three dot-separated numbers and an optional - or + suffix of letters, digits, dots and hyphens, in at most 64 characters`
   - `release.gated is not 40 lowercase hexadecimal characters`, and the same for
     `release.commit` and `release.shasum`
   - `release.base is not 40 lowercase hexadecimal characters or null`
   - `release.tarball is not a non-empty string`
   - `release.tarball_sha256 is not 64 lowercase hexadecimal characters`, and the
     same for `release.record_sha256`, `release.gate_check_sha256`,
     `release.gate_summary_sha256` and `release.task_receipt_hash`
   - `release.pushed is not a non-empty list of non-empty strings`
   - `release.<name> is not a field of a release`, for each other field
5. The document hash of `release` equals `content_hash`. If the release cannot
   be hashed: `the release cannot be hashed`. If it differs:
   `content_hash is not the hash of the release`.
6. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
7. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this release receipt`.

**Held against what a reader was offered.** A reader who holds a version, a
commit, a tarball hash, a release record hash, a run and a task can ask whether
the receipt names exactly those. That comparison does not look at the signature.
It gives one reason for each of `release.version`, `release.commit`,
`release.tarball_sha256`, `release.record_sha256`, `run_id` and `task_id` that
differs, as `<field> is <held>, not the <offered> offered`, and one reason when
the document is not an object or has no `release` object. No reason means the
receipt names what was offered.

What the document says it does not establish:

- A valid release receipt proves the holder of the carried key issued it and that it was not edited since.
- It does not prove the key is the company’s. The carried key is the issuer’s only if the verifier already holds that key_id from somewhere else; a receipt cannot vouch for its own key.
- It does not prove that the tarball in any registry is the one hashed, or that the release record, the gate’s files or the task receipt are the ones whose hashes it holds: it cannot see them.
- It does not prove the release is good.
- limits is not covered by the signature: someone who removes it leaves a receipt that still verifies.

## A receipt of version two, `tick.receipt.v2`

The acceptance, signed by the acceptor's coordinator, binding the three documents
before it: the work order, the delivery and the check record. It has a task
receipt's canonical form, document hash, key, `key_id`, `signature` and `limits`.
`tick.receipt.v1` keeps its schema, its fields and its check unchanged; the two
are different documents and a verifier tells them apart by `schema`.

- `schema`: `tick.receipt.v2`
- `alg`: `ed25519`
- `issued_at`, `coordinator`: As for a work order
- `receipt_id`: The receipt, a non-empty string
- `receipt`: The signed body, below
- `content_hash`: The document hash of `receipt`
- `key`, `key_id`, `signature`, `limits`: As for a work order

The body, `receipt`:

- `order`: The work order document, whole
- `delivery`: The delivery document, whole
- `check`: The check record document, whole
- `acceptance`: `{ by, who, at }`: `by` is `person`, `auto-tick` or `checks`; `who` a non-empty string, the person's name (the order's acceptor `name`) or `checks`. `auto-tick` says the person's auto tick approved, on their standing yes and not by their own touch, through whichever runner of that person's company decided the gate; `who` is that person, never the runner; `at` an ISO 8601 time
- `money`: `{ kind: "none" }`: no money is held or paid by this receipt

**What is signed.** The UTF-8 bytes of this string, with the two values filled
in: `tick-receipt:v2:<receipt_id>:<content_hash>`. The signature is over those
bytes themselves, with no pre-hashing. The label `tick-receipt:v2` is carried by
no other signature Tick makes. It is the acceptor's signature only: each embedded
document keeps its own signature, made by its own key under its own label.

**`alg` names one algorithm.** A later version may carry a second signature
beside the first, such as a post-quantum one (TN4.5). A verifier refuses an `alg`
it does not know.

**The check.** Every failure below is reported, so a reader sees all that is
wrong and not only the first. A receipt is valid when none of them applies.

1. `schema` is `tick.receipt.v2`. If not: `the schema is <schema>, not tick.receipt.v2`.
2. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
3. `issued_at` is an ISO 8601 time. If not: `issued_at is not an ISO 8601 time`.
   `coordinator` and `receipt_id` are non-empty strings. If not:
   `<field> is not a non-empty string`.
4. `receipt` is an object. If not: `receipt is not an object`. Then the fields
   of the body that are not documents, one reason for each that is missing or of
   the wrong shape:
   - `receipt.acceptance is not an object`
   - `receipt.acceptance.by is not person, auto-tick or checks`
   - `receipt.acceptance.who is not a non-empty string`
   - `receipt.acceptance.at is not an ISO 8601 time`
   - `receipt.money is not { kind: "none" }`
5. Each embedded document passes its own check: `order` the work order's,
   `delivery` the delivery's and `check` the check record's. Each of its reasons
   is reported as it is written for that document, with its role and `: ` in
   front: `order: <reason>`, `delivery: <reason>`, `check: <reason>`. A document
   that is missing or is not an object is reported by its check's first reason,
   for example `check: it is not a check record: it is not a JSON object`.
6. The chain holds. Each broken link is its own reason, given in the next
   section. A link is checked when both of its documents are objects.
7. The document hash of `receipt` equals `content_hash`. If the body cannot be
   hashed: `the receipt cannot be hashed`. If it differs:
   `content_hash is not the hash of the receipt`.
8. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
9. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this receipt`.

**Who signed.** The verdict also names the `key_id` behind each role: `buyer`
(the work order's key), `doer` (the delivery's), `checker` (the check record's)
and `acceptor` (the receipt's own), each computed from the key the document
carries, or none when it carries none. It also lists each group of roles whose
documents carry one key, in the order buyer, doer, checker, acceptor. A reader
sees by it when one company held two roles. A valid receipt is itself the
acceptance: no other statement is needed to say the work was accepted.

What the document says it does not establish:

- A valid receipt says each party’s key signed its own part and the parts chain. It does not say any party told the truth.
- The carried keys are the parties’ only if the verifier already holds those key_ids from somewhere else. A receipt cannot vouch for its own keys. When two roles are signed by one key, one holder signed both.
- The acceptance names who accepted. The signature proves the acceptor’s key signed the receipt, not that the person named did.
- money none means no money is held or paid by this receipt.
- limits is not covered by the signature: someone who removes it leaves a receipt that still verifies.

## A landing's receipts in git, `tick.landing-receipts.v1`

The receipts of what a landing carries, kept in git beside the code so that a
clone can check its own history without the coordinator. Tick writes one as a git
note on the landing's commit under `refs/notes/tick`, on one line of JSON, and
pushes that ref to origin and to each backup.

- `schema`: `tick.landing-receipts.v1`
- `commit`: The landing's commit, 40 lowercase hexadecimal characters
- `receipts`: The `tick.receipt.v2` of each implement task the landing carries, whole; for a release commit, its `tick.release-receipt.v1`

**It is not signed itself.** Nothing in this document is covered by a signature
of its own. Each receipt in it carries its own signature and is checked as its
kind is, by this package: the offline verifier, `verifyDocument`, on the receipt
alone. A reader counts a landing from its note only when every receipt in it is
valid, each names the landing, and together they name every task the landing
carries. A note that is missing, whose receipt does not verify (one changed byte
is enough), or that lacks a task's receipt is not trusted: the reader asks the
coordinator instead, or reports a gap.

A note holds what its writer chose to put in it, so it proves no more than the
receipts do. It cannot show that a receipt was left out except by a reader who
knows which tasks the landing carries, and it does not say the landing is good.

## How the four documents chain

The work order, the delivery, the check record and the receipt are four documents
by up to four parties. The receipt holds the first three whole, and a verifier
checks that they refer to one another. Each broken link is reported with its own
text:

- The delivery names the order: `delivery.order_hash` is the order's `content_hash`. If not: `the delivery’s order_hash is not the order’s content_hash`.
- The delivery started where the order said: the delivery's `base` is the order's `base`. If not: `the delivery’s base is not the order’s`.
- The check ran for the same order: `check.order_hash` is the order's `content_hash`. If not: `the check’s order_hash is not the order’s content_hash`.
- The check ran the order's checks: `check.checks_hash` is the order's `checks_hash`. If not: `the check’s checks_hash is not the order’s checks_hash`.
- The check ran on what was delivered: the check's `repository`, `base`, `commit` and `tree` are the delivery's. If not, one reason for each: `the check’s repository is not the delivery’s`, and the same for `base`, `commit` and `tree`.
- The acceptor is the one the order names. `acceptance.by` is `checks` only when the order's acceptor kind is `checks`; if not: `the acceptance is by checks, but the order’s acceptor is not checks`. It is `person` only when the order's acceptor kind is `person` and `acceptance.who` equals the order's acceptor `name`; if the order's acceptor is not a person: `the acceptance is by a person, but the order’s acceptor is not a person`, and if the name differs: `the acceptance is by a person the order does not name`. It is `auto-tick` only when the order's acceptor kind is `person` and `acceptance.who` equals the order's acceptor `name`: the person on whose switch auto tick approved is the one the order names. If the order's acceptor is not a person: `the acceptance is by auto tick, but the order’s acceptor is not a person`, and if the name differs: `the acceptance is by auto tick for a person the order does not name`.
- No receipt accepts a check whose verdict is `failed`. If it does: `the receipt accepts a check whose verdict is failed`.

Two things are not links. Nothing makes the parties different, so one key may sign
several roles, and the verdict's `signers` says when it did. And nothing here
checks the territory or reruns a command: `territory_held` and the results are
what the checker's key says it found.

## A project's statement, `tick.project-receipt.v2`

Every try of every task of one project, accepted, failed or dropped, with what
each cost, signed by the project's coordinator. It has a task receipt's
canonical form, document hash, key, `key_id`, `signature` and `limits`.

- `schema`: `tick.project-receipt.v2`
- `alg`: `ed25519`
- `issued_at`, `coordinator`: As for a work order
- `run_id`: The run, a non-empty string
- `statement`: The signed body, below
- `content_hash`: The document hash of `statement`
- `key`, `key_id`, `signature`, `limits`: As for a work order

The body, `statement`:

- `run`: The run's header as the coordinator's ledger holds it: an object whose `run_id` is the document's `run_id`
- `tasks`: A list, one for each task of the run, each `{ task_id, type, step_of, final_state, disposition, receipt, tries }`: `task_id` a non-empty string; `type` the task's type as the run's plan holds it, amendments included, a non-empty string, such as `implement` for a task sent to a project, `integrate` and `land` for the steps Tick sends with it, or `finish` and `release` for Tick's own tasks of a project, and `unknown` where the plan names none; `step_of` the `task_id` of the task an `integrate` or `land` step puts together or lands, a task this statement also lists, and `null` for every other task; `final_state` and `disposition` a string or `null`; `receipt` the content hash of the task's own receipt (`tick.receipt.v1`), 64 lowercase hexadecimal characters, or `null` for a task that has none; `tries` a list, one for each attempt in the ledger's order
- Each try: `{ attempt_id, agent, model, minutes, outcome, usd_micros, cost }`: `attempt_id`, `agent` and `outcome` non-empty strings, the `agent` `unknown` where the attempt never reported one; `model` a string or `null`; `minutes` a finite number of zero or more, or `null`; `usd_micros` what the try cost in whole millionths of a US dollar, a whole number of zero or more, or `null`; `cost` one of `metered`, `reported` or `unknown`. A try's `cost` is `unknown` exactly when its `usd_micros` is `null`
- `totals`: `{ tries, tries_unknown, usd_micros_reported, usd_micros_metered }`, whole numbers of zero or more: how many tries the statement lists, how many have no figure, and the sums of the figures marked `reported` and `metered`
- `previous`: The content hash of the statement before this one, as the one who asked for this statement named it, or `null`
- `ledger_hash`: The document hash of the run's ledger: the `content_hash` of the run's `tick.audit-export.v1`

Money is in whole micro-dollars so that every verifier, in any language, adds it
up to the same number. A dollar figure becomes micro-dollars read to 12
significant digits, a half rounding up, so that 0.145 dollars is 145000 and
0.0000005 dollars is 1.

**A task and its steps.** A task sent to a project travels with two steps of
its own, an `integrate` step that puts its work together and a `land` step that
lands it once it is accepted, and each names the task in `step_of`. A reader puts
each step's tries under the task it serves. A task's `receipt` is set when it
succeeded and the last gate decision on it is an approval. The person's yes to a
task's work is the gate on its `land` step, so a task's acceptance is read from
the `land` step that names it: the task was accepted when that step carries a
`receipt`.

**What is signed.** The UTF-8 bytes of this string, with the two values filled
in: `tick-project-receipt:v2:<run_id>:<content_hash>`. The signature is over
those bytes themselves, with no pre-hashing. The label `tick-project-receipt:v2`
is carried by no other signature Tick makes.

**`alg` names one algorithm.** A later version may carry a second signature
beside the first, such as a post-quantum one (TN4.5). A verifier refuses an `alg`
it does not know.

**The check.** Every failure below is reported, so a reader sees all that is
wrong and not only the first. A statement is valid when none of them applies.

1. `schema` is `tick.project-receipt.v2`. If not: `the schema is <schema>, not tick.project-receipt.v2`.
2. `alg` is `ed25519`. If not: `the algorithm is <alg>, not ed25519`.
3. `issued_at` is an ISO 8601 time. If not: `issued_at is not an ISO 8601 time`.
   `coordinator` and `run_id` are non-empty strings. If not:
   `<field> is not a non-empty string`.
4. `statement` is an object. If not: `statement is not an object`. Then each
   field of the body, one reason for each that is missing or of the wrong shape:
   - `statement.run is not an object holding a run_id`, or, when it holds one that is not the document's `run_id`, `run_id is not the statement’s run`
   - `statement.tasks is not a list`; and for the task at index `i`:
     `statement.tasks[i] is not an object`,
     `statement.tasks[i].task_id is not a non-empty string`,
     `statement.tasks[i].type is not a non-empty string`,
     `statement.tasks[i].step_of is not the task_id of another task of the statement, or null`,
     `statement.tasks[i].final_state is not a string or null` and the same for `disposition`,
     `statement.tasks[i].receipt is not 64 lowercase hexadecimal characters, or null`,
     `statement.tasks[i].tries is not a list`
   - for the try at index `j` of the task at index `i`, written `<try>` for `statement.tasks[i].tries[j]`:
     `<try> is not an object`,
     `<try>.attempt_id is not a non-empty string` and the same for `agent` and `outcome`,
     `<try>.model is not a string or null`,
     `<try>.minutes is not a finite number of zero or more, or null`,
     `<try>.usd_micros is not a whole number of zero or more, or null`,
     `<try>.cost is not metered, reported or unknown`,
     `<try>.cost is unknown, but its usd_micros is not null`,
     `<try>.usd_micros is null, but its cost is <cost>`
   - `statement.totals is not an object`; `statement.totals.<name> is not a whole number of zero or more`
   - `statement.previous is not 64 lowercase hexadecimal characters, or null`
   - `statement.ledger_hash is not 64 lowercase hexadecimal characters`
5. The totals are the tries' own. Where every task and try has the shape above,
   each total is added up again from the tries: `tries` counts them,
   `tries_unknown` counts those whose `cost` is `unknown`, and
   `usd_micros_reported` and `usd_micros_metered` add the `usd_micros` of the
   tries marked so. Each total that differs is its own reason:
   `statement.totals.<name> is not the sum of the tries`. A sum past 2^53 is
   not a number every verifier holds exactly:
   `statement.totals cannot be added up exactly: a sum passes 2^53`.
6. The document hash of `statement` equals `content_hash`. If the statement
   cannot be hashed: `the statement cannot be hashed`. If it differs:
   `content_hash is not the hash of the statement`.
7. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes
   of `key`. If not: `key_id is not the carried key’s`.
8. `key` is an Ed25519 public key and `signature` verifies, under it, over the
   bytes above. If not: `the signature is not the carried key’s over this statement`.

What the document says it does not establish:

- The signature proves the holder of the carried key issued this statement, and content_hash that it was not edited since. It does not prove the coordinator reported the truth.
- A try marked reported has the figure the agent’s own platform gave; Tick did not measure it. A try marked unknown has no figure and is counted in tries_unknown, never as zero.
- A try that produced no event is not here.
- ledger_hash names the run’s full ledger, which this statement does not carry: only someone who holds the ledger can check it.
- type and step_of are read from the run’s plan as the coordinator holds it, not from the ledger: ledger_hash does not cover them.
- previous is the statement the asker named as the one before; the coordinator keeps no chain of what it issued.
- The carried key is the company’s only if the verifier already holds that key_id from somewhere else. A statement cannot vouch for its own key.
- limits is not covered by the signature: someone who removes it leaves a statement that still verifies.

## A company's index of its published projects, `tick.hub-index.v1`

What a company publishes on TickHub: for each project, the runs whose
statements it shows and which statement of each is newest, signed by the
company's coordinator. It has a task receipt's canonical form, document hash,
key, `key_id`, `signature` and `limits`.

- `schema`: `tick.hub-index.v1`
- `alg`: `ed25519`
- `issued_at`, `coordinator`: As for a work order
- `index`: The signed body, below
- `content_hash`: The document hash of `index`
- `key`, `key_id`, `signature`, `limits`: As for a work order

The body, `index`:

- `publisher`: Who the coordinator holds as the company's owner, as a work order's acceptor names it: a non-empty string
- `previous`: The content hash of the index this one replaces, or `null` for the first. The coordinator signs only an index whose `previous` is an index it signed itself, so one folder's indexes form one chain under one key
- `projects`: A list sorted by `slug`, each `{ slug, name, repository, runs }`: `slug` lowercase letters and digits joined by single hyphens, no two the same; `name` and `repository` non-empty strings; `runs` a non-empty list, each `{ run_id, statements, head }`: `run_id` a non-empty string, no two the same in one project; `statements` a non-empty list of statement content hashes (`tick.project-receipt.v2`), oldest first, none twice; `head` the last of them

**What is signed.** The UTF-8 bytes of `tick-hub-index:v1:<content_hash>`, with
no pre-hashing. The label `tick-hub-index:v1` is carried by no other signature
Tick makes.

**The check.** Every failure below is reported. An index is valid when none of
them applies.

1. `schema` is `tick.hub-index.v1`; `alg` is `ed25519`; `issued_at` is an ISO 8601 time; `coordinator` is a non-empty string. Each that is not is its own reason, worded as for a work order.
2. `index` is an object. If not: `index is not an object`. Then:
   - `index.publisher is not a non-empty string`
   - `index.previous is not 64 lowercase hexadecimal characters, or null`
   - `index.projects is not a list`; for the project at index `i`, written `<project>` for `index.projects[i]`: `<project> is not an object`, `<project>.slug is not lowercase letters and digits joined by single hyphens`, `<project>.name is not a non-empty string` and the same for `repository`, `<project>.runs is not a non-empty list`, `<project>.runs names one run twice`; for its run at index `j`, written `<run>`: `<run> is not an object`, `<run>.run_id is not a non-empty string`, `<run>.statements is not a non-empty list of 64 lowercase hexadecimal characters each`, `<run>.statements names one statement twice`, `<run>.head is not the newest of its statements`
   - `index.projects names one slug twice`, or, when none is twice, `index.projects is not sorted by slug`
3. The document hash of `index` equals `content_hash`. If the index cannot be hashed: `the index cannot be hashed`. If it differs: `content_hash is not the hash of the index`.
4. `key_id` is the first 16 hexadecimal characters of the SHA-256 of the bytes of `key`. If not: `key_id is not the carried key’s`.
5. `key` is an Ed25519 public key and `signature` verifies, under it, over the bytes above. If not: `the signature is not the carried key’s over this index`.

What the document says it does not establish:

- The signature proves the holder of the carried key issued this index, and content_hash that it was not edited since. It does not prove that the statements it names say anything true: each proves only itself.
- The carried key is the company’s only if the verifier already holds that key_id from somewhere else, such as the key file on the company’s own website.
- An index lists what its publisher chose to publish; a project or a run it leaves out is not shown to be absent.
- limits is not covered by the signature: someone who removes it leaves an index that still verifies.

## The keys a company names, `tick-keys/1`

The file a company serves at `/.well-known/tick-keys.json` on its own website:
the key ids it stands behind, so that a reader holds a `key_id` from somewhere
other than the document that carries it. It is not signed: its authority is
the domain that serves it.

- `schema`: `tick-keys/1`
- `keys`: A non-empty list, each `{ key_id, role, from }`: `key_id` 16 lowercase hexadecimal characters, no two the same; `role` `coordinator` for the key that signs receipts, statements and indexes, or `release` for the key that signs releases; `from` the day the company first named it, `YYYY-MM-DD`

A new key is a new entry. An entry is never edited or removed, so a receipt
signed under an older key can still be placed.

**The check.** `schema` is `tick-keys/1`; `keys is not a non-empty list`; for
the key at index `i`: `keys[i] is not an object`,
`keys[i].key_id is not 16 lowercase hexadecimal characters`,
`keys[i].role is not coordinator or release`,
`keys[i].from is not a day, YYYY-MM-DD`; and `keys names one key_id twice`.

## What a valid verdict means

That the document is the one that was written: not one byte of what the hash or
the signature covers has changed since. For a receipt it also means that whoever
holds the private half of the carried key issued it.

It does not mean the coordinator told the truth, and it does not mean the key is
the company's. A receipt carries its own key and cannot vouch for it: to rely on
one, hold the `key_id` from somewhere else, such as the company's published
list, and compare. Nothing here decides that for you.

For a receipt of version two a valid verdict means that each party's key signed
its own part (the work order, the delivery, the check record and the receipt) and
that the parts chain. It still does not mean that any party told the truth: not
that the buyer meant what the order says, that the doer's tries cost what they
say, that the checker ran the commands as recorded, or that the person named
accepted. The verdict names the key behind each role so that a reader can hold
each `key_id` against what they know.

## What this package does not do

- It checks Ed25519 signatures only, and refuses a receipt that names another
  algorithm.
- It does not check the coordinator's signed chain checkpoints, which are a
  different document.
- It does not fetch anything. Holding a key or a company's record is yours to do.

## Using it

`tick-verify <file>` reads one file, prints the verdict and the document's own
limits (for a receipt of version two, also the `key_id` behind each role and any
roles that share one key), and exits 0 when the document is valid, 1 when it is not, and 2 when
there is no file or it cannot be read. As a library, `verifyDocument(text)`
picks the check by the document's `schema`; `verifyTaskReceipt`,
`verifyAuditExport`, `verifyAuditTrailExport`, `verifyWorkOrder`,
`verifyDelivery`, `verifyCheckRecord`, `verifyReleaseReceipt` and `verifyTaskReceiptV2` check one kind each, `releaseReceiptDisagreements` compares a release receipt with what was offered, and
`canonicalSerialize` is the form, `documentHash` is what a document's `content_hash` holds, and `contentHash` is the plain hash of the canonical form alone.
