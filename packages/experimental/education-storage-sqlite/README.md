---
description: "Save private education drafts and immutable versions in an isolated SQLite database with transactional ownership and request receipts."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-education-storage-sqlite

English | [中文](README.zh.md)

## Summary

Save employee-owned projects, synchronize drafts and append immutable formal versions in one independent database. Writes atomically retain request receipts and audit metadata. Conflicting draft revisions or formal pointers reject without overwriting text. The provider validates durable login state on each private operation and releases its database on unload.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Select the [foundation bundle](../education-bundle/README.md) with an absolute `EDUCATION_DATABASE_PATH` in an isolated development environment. Initialization rejects a foreign database, a future schema, incomplete tables or invalid foreign-key associations before providing the repository.

### Configuration

The [configuration parser](src/index.ts) owns these validated fields.

| Field | Default | Meaning |
|---|---|---|
| `path` | Required | Absolute isolated database file; `:memory:` is supported for tests. |
| `journalMode` | `wal` | `wal`, `delete`, `truncate` or `persist`; deployment storage needs qualification. |
| `busyTimeoutMs` | `1000` | Finite lock wait from 1 through 60000 milliseconds. |
| `maxBodyBytes` | `1048576` | Maximum UTF-8 bytes after CRLF normalization. |
| `maxTitleBytes` | `200` | Maximum UTF-8 bytes in a trimmed title or organization name. |
| `maxPageSize` | `100` | Maximum query page size; configuration accepts 1 through 1000. |

### Writes and recovery

The repository normalizes only CRLF to LF and retains spaces and Unicode. Draft synchronization increments only the draft revision. Formal saving checks both baselines and fixes the text and its original evidence without changing that revision. Existing empty `foundation-validation` evidence stays unchanged. New generation fixes the profile/source versions, authorization revisions, run, policy and context fingerprint. Restoration updates only the draft; a later save appends another version.

The monotonic business schema migrates to its second layout, adding immutable profiles and sources, current authorization, fixed input, run occupancy, conversation and receipts, and the `moments` scenario. Migration preserves original text, formal versions and receipts and rolls back on failure. Model calls run outside transactions. One active run occupies each artifact; cancellation, failure and interruption never commit partial output. Startup marks unsettled runs interrupted without resending model work. Source revocation hides dependent text and denies restoration and export. Explicitly clearing the current draft starts a safe context in the same project while retaining history.

Reuse the original request identity and parameters after a lost response. A matching receipt returns its original non-secret result after reauthorization; different parameters reject with `idempotency-conflict`. `storage-busy` permits bounded same-key retry. Other failures retain their internal cause; transport consumers must not expose it. A rollback failure closes the repository and stops dependent work.

Stop writers and close every connection before copying the database. Restore the closed file into a separate directory. The regression suite verifies counts, hashes, ownership, formal pointers and SQLite integrity after this procedure.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

[Schema initialization](src/schema.ts) uses a distinct application identifier and monotonic version stamp in one migration transaction. Composite foreign keys constrain organization, owner, project and artifact associations. Triggers prevent historical version updates and deletions. [Repository operations](src/repository.ts) use short synchronous transactions with no external awaits; authorization is checked again before committing writes. [Decoding](src/codec.ts) validates stored values and text digests.

`invalidateSessionBinding()` changes only an owned association to `invalid` and commits its audit record in the same transaction. Reads and receipt replay reject invalid associations. It preserves native history and the current business schema; runtime cancellation belongs to the [identity resource policy](../education-identity/src/authorization.ts). Native Agent creation and this database never share a transaction.

Revision and version counters reject unsafe-integer increments before mutation. `onProjectCommit()` emits body-free metadata only after a new transaction commits; observer failures are reported separately and cannot turn a committed write into a failure. Project reopening includes current version/binding metadata, and invalid external cursor fields are classified as input failures.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform requirements](../education-platform/README.md) — Host API and safe DTO entry.
- [Foundation bundle](../education-bundle/README.md) — isolated Profile composition.
- [Repository tests](tests/repository.spec.ts) — real transaction and restoration evidence.

-----

<a id="model-experience"></a>
## Model Experience

None, as this database provider does not construct model prompts, tools or Session events.

#### KV Cache effect

None; storing business text does not inject it into a model request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The deployment and transport restrictions are explicit.

- The verification environment is a local disk with one business writer; network mounts and multiple instances are not qualified.
- Login HTTP, credential verification, Peer lifetime and native Session authorization remain separate identity and controller work. Controlled account provisioning is not an employee signup API.
- Existing prototype JSON records and native Session storage are not migrated. A Session binding alone does not authorize native RPC, files or event delivery.
- The database parent directory must prevent replacement by other principals; filesystem modes do not establish that protection on every platform.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
