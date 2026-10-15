---
description: "Explicit native employee workspace with private creation, authorized sources and isolated business storage."
kind: "package-bundle"
---

# @deepseek-ai/dsh-experimental-education-bundle

English | [中文](README.zh.md)

## Summary

Use employee sign-in, private projects, drafts and saved versions in an independent business database. The [native writing panel](../education-shell/README.md) creates content from the employee's confirmed profile and authorized text sources. This explicit composition stays outside default coding Profiles.

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

### Enable in development

After installing dependencies and running `pnpm run build`, run `pnpm run start:education` from the repository root. It launches the named `education` Profile at `http://127.0.0.1:3191/` by default; anonymous requests enter a separate sign-in document. First startup initializes the database, Profile and a controlled initial account under `.cache/education-native`. The terminal prints the `first-login.txt` path, never the password. `pnpm run setup:education:native` only initializes; `pnpm run start:education:prototype` retains the standalone prototype.

`deployment.json` stores the organization, database and port. `EDUCATION_NATIVE_HOME` selects an independent data directory and `EDUCATION_NATIVE_PORT` overrides the local port; separate deployments use separate databases. `EDUCATION_MODEL_PROVIDER`, `EDUCATION_MODEL` and `EDUCATION_MODEL_CREDENTIAL_REF` select the route, model and native credential reference. `EDUCATION_CREDENTIALS_PATH` can select an existing native credential file. The helper otherwise reuses the user's native file, selecting `deepseek-account` when its grant exists, or `deepseek-official` with the `DEEPSEEK_API_KEY` reference. Secrets are not copied into business storage, browser data or model input.

Set `EDUCATION_BOOTSTRAP_USERNAME` and run `pnpm run add-user:education` to provision another employee. `EDUCATION_BOOTSTRAP_PASSWORD` optionally supplies a password of at least twelve characters; omission generates one. The helper uses the same repository and password derivation rules and writes login details to a private `accounts` file in that deployment. No public registration or employee administration endpoint is exposed.

Use an isolated `DSH_HOME` and add `@deepseek-ai/dsh-experimental-education-bundle` after the shipped bundle names in that Profile's `dsh.profile.bundles`. Set `EDUCATION_DATABASE_PATH` to an absolute separate database path. The package and its dependencies must be installed and built in the development workspace. An arbitrary `--patch` containing bare package names does not add those packages to Profile runtime resolution.

The [Loader regression](tests/loader.spec.ts) initializes its own headless Profile with that bundle selection and launches the supported `dsh` CLI in both source and built modes. It provisions explicitly synthetic employees, commits a private draft and version, verifies owner denial, then unloads the provider and checks closure. Run it from a built checkout:

```text
node node_modules/vitest/vitest.mjs run packages/experimental/education-bundle/tests/loader.spec.ts
```

### What you get

The [patch](cordis.patch.yml) adds the ready SQLite repository and its Host consumer. HTTP authentication is disabled by default. Set `EDUCATION_IDENTITY_ENABLED=true`, `EDUCATION_ORGANIZATION_ID` and `EDUCATION_IDENTITY_PUBLIC_ORIGIN` after controlled account provisioning to activate the identity group; `EDUCATION_IDENTITY_PORT` selects its loopback listener (default 3191). The [identity regression](tests/identity-loader.spec.ts) uses an OS-assigned test port and real cookie requests. `EDUCATION_CONTROLLER_ENABLED=true` and `EDUCATION_CLIENT_ENABLED=true` select the Controller and native panel inside that group. The [Client browser test](../education-shell/tests/native-browser.e2e.ts) uses the native Web test Profile and one listener for identity/API. Controlled test provisioning is not production account administration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The provider publishes `educationRepository` after validating the medium. `educationPlatform` injects that service, so it does not activate with a failed or pending database. Unloading the provider removes both active services and closes the medium. The package manifest declares every plugin named by the patch; Profile bundle selection makes that dependency graph available to the runtime resolver.

Set `EDUCATION_CONTROLLER_ENABLED=true` to enable the [Controller](../education-controller/README.md) inside the explicit identity layer. It requires a selected Connection with required request policy, identity adaptation, Session Query and Typert. The bundle does not silently replace a default operator deployment. Real src/lib tests cover native authorization, project/draft/version RPC, concurrent conflicts, original-request recovery, project follow and exact text export.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform](../education-platform/README.md) — trusted Host API and DTOs.
- [SQLite provider](../education-storage-sqlite/README.md) — atomic writes and configuration.
- [Application boot](../../boot/app-boot/README.md) — Profile and bundle resolution.

-----

<a id="model-experience"></a>
## Model Experience

Indirectly, through the selected [creation Controller](../education-controller/README.md#model-experience), which owns model-facing rules and native Agent execution.

#### KV Cache effect

The bundle adds no prompt prefix. The Controller captures each complete, authorized input and starts a fresh tool-free native Agent for that input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The startup helper provides the explicitly selected local employee composition; deployment administration remains controlled Host work.

- Use one application process for each business database. Account provisioning uses the local helper; public registration, password reset and production deployment automation are outside this composition.
- The employee patch omits operational UI entries and denies ungranted controllers and events. The default Web operator keeps its existing composition.
- Prototype data stays separate. External analytics ingestion and scheduled synchronization are later-stage integrations.
- Ordinary automated tests use synthetic replies. The opt-in real-model test requires explicit authorization and a persistent call budget; recorded sessions replay without credentials or further model calls.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
