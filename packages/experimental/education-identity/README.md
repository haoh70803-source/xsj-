---
description: "Durable employee login, private current identity and logout through controlled cookie HTTP routes in isolated development Profiles."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-education-identity

English | [中文](README.zh.md)

## Summary

Employees can log in, read their current identity and log out through three controlled HTTP endpoints. Each request checks its Host, Origin and current durable login state. Password verification follows the prototype's scrypt and username rules; the repository stores token digests. The provider bounds authentication work and drains accepted verifications when unloaded.

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

Select the [education bundle](../education-bundle/README.md) in an isolated headless Profile and explicitly enable its identity layer. Provision the configured organization and employee credentials through controlled Host setup before loading the provider. The organization must exist and be active. The provider exposes no public signup or account-administration route.

### Configuration

The [provider configuration](src/types.ts) owns these deployment bounds. Remote browser origins require HTTPS; plain HTTP is restricted to explicit loopback origins. Paths, credentials and query strings are rejected in the configured origin.

| Field | Default | Meaning |
|---|---|---|
| `organizationId` | Required | Existing active organization UUID. |
| `publicOrigin` | Required | Exact browser origin used for Host and mutation-Origin checks. |
| `sessionLifetimeMs` | `43200000` | Absolute durable login lifetime; 60000 through 604800000 milliseconds. |
| `loginAttempts` | `10` | Attempts per direct address and normalized username in each window. |
| `loginWindowMs` | `900000` | Attempt window; 1000 through 86400000 milliseconds. |
| `maxConcurrentVerifications` | `4` | Concurrent password-verification cap; 1 through 64. |
| `maxThrottleKeys` | `10000` | Maximum unexpired throttle entries; 2 through 100000. |
| `maxAuthRequestBytes` | `4096` | Complete buffered HTTP authentication body cap; 256 through 65536 bytes. |
| `adaptConnection` | `false` | Opt into employee Peer admission; Connection must set `requireRequestPolicy: true`. |
| `loginShell` | `false` | Serve the public employee sign-in document and redirect anonymous index access; requires `adaptConnection`. |
| `maxPeers` | `1000` | Active native login scopes; 1 through 100000. |
| `peerSweepIntervalMs` | `1000` | Idle authorization checks; 10 through 60000 milliseconds. |

### HTTP and lifecycle

`POST /education/auth/sign-in` accepts only username/password JSON and requires the configured Origin. `GET /education/auth/me` returns only the current public employee DTO. `POST /education/auth/sign-out` requires the mutation Origin, revokes the current active login and clears the cookie. Responses use `Cache-Control: no-store`; cookie values are response headers, never response JSON. Invalid, disabled, expired and revoked logins do not authenticate.

With `loginShell: true`, anonymous index requests redirect to `GET /education/sign-in`. This exact route serves a Chinese/English login document with a nonce-bound content policy, submits to the same-origin authentication route and reloads the native workspace after success. It exposes no native operator boot metadata. The [employee startup helper](../education-bundle/README.md#use-this-package) selects this configuration and the restricted Web roster together.

Cookies use a namespace distinct from the prototype and native operator cookies, with HttpOnly, SameSite=Strict, Path=/ and an absolute Max-Age. HTTPS adds Secure and the `__Host-` prefix. A valid login remains durable across restart; unloading stops new verification and waits for accepted work without minting late logins. Individual logout leaves other employees and other logins intact.

Controlled setup can use the Node-only credential helper in [credentials.ts](src/credentials.ts). Passwords retain spaces and case. New credentials require at least twelve characters; username normalization uses NFKC, trim and lowercase, then the existing ASCII grammar. No raw token, password or credential hash is returned in the employee DTO.

The opt-in [Connection adapter](src/connection.ts) provides Host-only `ctx.educationPeers.actor(peer)` and a lifetime signal. One durable login uses a stable Peer; employees and repeated logins have separate scopes. Logout aborts the matching scope immediately. Every identity lookup revalidates durable authorization; idle expiry and account revocation are checked on the configured interval. Unload aborts scopes, awaits their disposal and withdraws the policy. The adapter also installs the [resource policy](src/authorization.ts); the native enterprise UI/Profile remains a separate delivery.

`ctx.educationAuthorization` denies unknown operations. It permits native `session.page`, `session.follow` and `session.projections` only for active same-owner bindings; subagent addresses, global lists/search/control, free creation, prompt/cancel, raw file upload/download and operational namespaces remain closed. Scoped events require an explicitly adopted live Agent whose actual subject and Session identity match the registry and binding. Global events are denied without an explicit feature grant. Gateway rechecks events on initial/reconnect delivery, after queuing and before reply settlement; private Host home metadata is withheld.

Trusted feature plugins register resource-checking grants with `register()`. Each grant belongs to its caller fiber; withdrawal closes existing Peer scopes so idle subscriptions cannot retain it. `bindAgent()` adopts a controlled native handle, verifies its live identity and commits a same-owner association; failure awaits handle disposal without claiming a cross-database transaction. The caller must create the handle under its restricted validation setup and must not drive an unbound Agent. `invalidateSession()` commits binding revocation and audit together, closes that owner's current Peer scopes, then releases the adopted Agent. Other employees remain connected; valid cookies may reconnect and must reauthorize. Denial audit logs contain actor identifiers and fixed reason/category fields, never request arguments or private text.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [provider](src/index.ts) reads current account credentials, verifies salted scrypt outside database transactions, then rechecks authorization when creating the durable login. Current identity resolves the cookie digest through the selected [repository](../education-platform/src/repository.ts). The [HTTP adapter](src/http.ts) uses Connection's bounded Node-to-Fetch bridge and reversible exact Web routes. It returns stable error categories without serializing internal causes or credential values.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Platform](../education-platform/README.md) — trusted Actor and public DTO requirements.
- [SQLite](../education-storage-sqlite/README.md) — durable login and resource authorization.
- [Bundle tests](../education-bundle/tests/identity-loader.spec.ts) — real source/built Profile HTTP verification.

-----

<a id="model-experience"></a>
## Model Experience

None, as authentication does not construct model prompts, tools or Session events.

#### KV Cache effect

None; credentials and cookies do not enter model input.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

The resource policy protects the explicitly selected employee composition; deployment and account administration remain separate Host responsibilities.

- Real source/built Profiles verify native history, live follow, scoped event isolation, binding compensation, raw upload/export refusal and revocation. The [business Controller](../education-controller/README.md) owns controlled downloads; each feature grant validates its own external fields and associated resources.
- Public registration, production invitation/reset administration and administrator access rules are not provided.
- Gateway consumes the Peer lifetime signal for logical streams and event generations; identity validity alone grants no private-resource permission.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
