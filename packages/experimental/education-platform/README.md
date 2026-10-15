---
description: "Private education resource DTOs and Host repository requirements for developers composing the storage foundation."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-education-platform

English | [中文](README.zh.md)

## Summary

Host consumers can read and write employee-owned projects through an explicitly selected transactional repository. Every private operation requires a server-resolved actor. The browser-safe types export contains resource DTOs without credentials. This package exposes no HTTP or Remote controller.

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

`educationRepository.creation` uses the same database and actor authorization for immutable profiles, source versions, fixed model input, persistent runs, conversation and original mutation receipts. `creation-context` evidence extends the original `foundation-validation` branch; old formal versions are never backfilled. The [Controller](../education-controller/README.md) owns external request validation and the [SQLite provider](../education-storage-sqlite/README.md) owns transactions and migrations.

Select [education-bundle](../education-bundle/README.md) in an isolated development Profile. Its SQLite provider becomes ready before the Host service activates; consumers inject `educationPlatform` and use its `repository` with an explicit actor.

### Configuration and imports

The service accepts no configuration. Host providers implement [EducationRepository](src/repository.ts); identity consumers alone use its credential records. Browser code imports types from `@deepseek-ai/dsh-experimental-education-platform/types`, which exports no Node implementation or credential fields.

Repository writes return non-secret committed references. Read operations return authorized text separately. Request-result lookup preserves the original result and checks the current login and resource ownership again.

Project reopening includes the latest formal-version summary and owned binding state. Artifact metadata and current drafts have separate authorized reads for resource checks and explicit export. The repository exposes effective byte/page limits and body-free post-commit observation; replayed requests and failed transactions emit no new commit. The [business Controller](../education-controller/README.md) consumes these requirements through the native Gateway.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [service](src/index.ts) activates only after `educationRepository` exists. [DTOs](src/types.ts) separate editable drafts from immutable formal versions. [Structured errors](src/error.ts) provide stable handling categories; transport consumers map them to safe responses and exclude internal causes.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [SQLite provider](../education-storage-sqlite/README.md) — transactions and deployment options.
- [Foundation bundle](../education-bundle/README.md) — explicit Profile composition.
- [Architecture](../../../docs/architecture.md) — service ownership and reversible plugins.

-----

<a id="model-experience"></a>
## Model Experience

None, as this Host service and its DTOs do not construct model requests, tool schemas or Session events.

#### KV Cache effect

None; the package does not change model-visible input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The foundation is available to controlled Host callers only.

- Login/cookie handling, employee Peer scopes, native access authorization and Remote controllers are not implemented here.
- No Client data object or business panel is registered; the types export alone is not native Client integration.
- Binding a native Session requires the caller to create a controlled Session and compensate for a failed association; two databases do not share a transaction.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
