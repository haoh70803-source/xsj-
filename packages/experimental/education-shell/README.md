---
description: "Optional native employee project editor with draft synchronization, immutable versions, controlled export, and identity cleanup."
kind: "package-plugin"
---

# @deepseek-ai/dsh-experimental-education-shell

English | [中文](README.zh.md)

## Summary

Write spoken scripts and moments posts in the native employee workspace using confirmed personal facts and authorized text. The panel manages private projects, conversation, direct editing, automatic draft synchronization, explicit immutable saves and authorized downloads. Identity changes clear all previous private state.

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

Use the [employee startup helper](../education-bundle/README.md#use-this-package), or explicitly select the bundle, identity, Controller and Client in a named Web Profile. The panel uses native Gateway, locale, renderer and main-slot layout; it also registers sidebar navigation when that shell is present. The selected employee Profile supplies its anonymous login document and omits operator navigation.

Save confirmed facts separately from writing preferences and prohibited promises. Import only explicitly chosen TXT/Markdown text, confirm permission, then select source versions for a creation request. Model explanations stay in the conversation and manuscript text stays in the editor. Selection edits protect LF text using a SHA-256 digest and UTF-16 coordinates. The manuscript starts collapsed and opens when text becomes available.

`autoSyncDelayMs` defaults to 800, `runPollIntervalMs` to 500, `contextRefreshIntervalMs` to 2000, and `maxTextFileBytes` to 1048576. Automatic synchronization is ordered, retains newer edits and pauses during IME composition; failures stop automatic retries. Source revocation hides dependent text, with cross-tab notifications and visible-page authorization refresh. An explicit reset preserves saved history and starts an empty safe context in the same project.

The panel lists only authorized projects. Create or open a project, edit plain text, and choose Sync draft or Save version. Save version first synchronizes local text, then supplies the confirmed draft revision and the retained latest-version pointer. Viewing history leaves the draft unchanged; Restore explicitly replaces the draft and leaves immutable versions intact. Unsynced text requires explicit discard before project changes, creation, restoration or logout. Closing a page with unsynced text or an uncertain write triggers the browser's standard leave-page protection.

Draft export is disabled while the editor has unsynced text. Version export uses the explicitly viewed immutable version. Both use the exact Controller download route with employee cookies and no filesystem path, token query or native Session ZIP fallback. The Client uses document-relative HTTP routes, matching Connection's browser carrier; a deployment proxy must forward the identity and API paths consistently.

Conflicts retain the editor and offer a server reload after the user copies or synchronizes text. An uncertain write locks further writes and retains its request id, arguments and completion handler. Check original request queries the receipt; a null receipt keeps the result unknown. Retry original request first checks again and otherwise resends the same arguments and key. A recovered draft synchronization does not automatically append a version; Save version remains explicit.

<a id="understand-the-implementation"></a>
## Understand the implementation

`EducationWorkspace` is internal to the browser package and contains no React or database dependency. Its immutable snapshots reach components through the renderer's injected observable hook. Components receive plain callbacks and framework-derived props. They do not receive Cordis Context, transport services or custom subscription hooks. CSS Modules consume the native semantic theme tokens; all UI copy belongs to the typed Chinese and English dictionaries. The app-level Toast entry outlives main-panel navigation.

Explicit login, logout, cross-tab identity notifications and confirmed identity loss clear catalogs, drafts, previews, notices and pending writes before new identity data can appear. Identity and project scopes abort HTTP reads and follow streams; generation checks discard late unary results and downloads. Focus and Connection reset recheck identity without discarding unsynced text solely because of a network outage. No project body or credential is written to localStorage, IndexedDB or a browser draft cache. Unloading removes slots, event listeners, Remote contributions and retained private state.

<a id="further-exploration"></a>
## Further Exploration

- [Controller requests and controlled export](../education-controller/README.md)
- [Business transaction rules](../education-storage-sqlite/README.md)
- [Client layering](../../../docs/subsystems/web-client.md) and [native slots](../../../docs/subsystems/slots.md)
- [State and component tests](tests/model.client.spec.ts), [native browser test](tests/native-browser.e2e.ts)

<a id="model-experience"></a>
## Model Experience

None, as this editor does not construct model input, tools or Session events.

#### KV Cache effect

None; editor text is transmitted only to authorized business operations and downloads.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The Client stores no private draft or uncertain-request buffer in localStorage or IndexedDB. Hard reload can lose unsynchronized edits; confirmed drafts and persistent runs reopen from the server.
- Project/version pages request thirty entries; the selected repository page limit must permit that request. Source and conversation reads use the configured repository page bound.
- Generation requires the selected native model provider to be configured. Generated drafts remain editable and formal saving remains an explicit user action.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

Run `node node_modules/vitest/vitest.mjs run packages/experimental/education-shell/tests` for local state, HTTP adapter and native-slot component coverage. Build this package before its browser test, then run `DSH_SNAPSHOT=replay node node_modules/vitest/vitest.mjs run --config packages/experimental/education-shell/vitest.browser.config.ts packages/experimental/education-shell/tests/native-browser.e2e.ts`. The test uses installed Edge by default; `EDUCATION_BROWSER_CHANNEL` selects another Playwright channel. It creates an owned temporary business database and records narrow-screen images under `.cache/education-native-client-tests`.

</details>
