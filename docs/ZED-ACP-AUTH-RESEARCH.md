# Zed Editor ACP Authentication Research

Researched: 2026-07-22 (Zed HEAD `4ebc1545`, Codex ACP `agentclientprotocol/codex-acp` v1.1.5)

---

## Executive Summary

Zed deliberately allows this sequence:

1. User clicks **Install** in the ACP Registry.
2. The agent appears **installed** in the UI.
3. User starts a thread with that agent.
4. Zed spawns the agent process, sends ACP `initialize`, then sends `session/new`.
5. If `session/new` returns ACP `AuthRequired`, Zed shows its authentication UI.

**This is not a shortcut or bug.** It reflects the fact that:

- **Installation** concerns distribution and launch — not credentials.
- **`initialize`** concerns protocol negotiation and auth-method discovery.
- **`session/new`** is where many agents enforce authentication.
- Credentials are normally owned by the external agent, not by Zed's native model-provider configuration.

The phrase `codex_api_key not set` means the Codex ACP process was launched successfully and the auth method was reached, but the selected credential was not available in that process's environment. This is not an installation failure or an ACP protocol failure; it means the user needs to set the environment variable or use a different auth method.

---

## Key Sources

| Component | File | Commit |
|---|---|---|
| Registry store | `crates/project/src/agent_registry_store.rs` | `4ebc1545` |
| Agent server store (materialization) | `crates/project/src/agent_server_store.rs` | `4ebc1545` |
| Registry UI | `crates/agent_ui/src/agent_registry_ui.rs` | `4ebc1545` |
| ACP process + initialize | `crates/agent_servers/src/acp.rs` | `4ebc1545` |
| Custom agent connect | `crates/agent_servers/src/custom.rs` | `4ebc1545` |
| AgentConnection trait (auth methods) | `crates/acp_thread/src/connection.rs` | `4ebc1545` |
| Conversation view (auth UI, session lifecycle) | `crates/agent_ui/src/conversation_view.rs` | `4ebc1545` |
| Thread view (auth error callout) | `crates/agent_ui/src/conversation_view/thread_view.rs` | `4ebc1545` |
| Zed docs for external agents | `docs/src/ai/external-agents.md` | `4ebc1545` |
| Old codex-acp Rust adapter | `zed-industries/codex-acp` tag `rust-v0.137.0` | `af1dcbd` |
| Current codex-acp TypeScript adapter | `agentclientprotocol/codex-acp` v1.1.5 | `2524dfb` |

---

## 1. Registry "Installation"

### What "Install" actually does

Zed's registry UI determines whether an agent is installed by checking `agent_servers` settings:

- [`agent_registry_ui.rs:146-166`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/agent_registry_ui.rs#L146-L166) — `refresh_installed_statuses` checks if the agent id exists in `AllAgentServersSettings` with a `Registry` variant.
- [`agent_registry_ui.rs:491-538`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/agent_registry_ui.rs#L491-L538) — **Install** writes a `CustomAgentServerSettings::Registry` entry to settings. That's it. The button is then relabeled **Remove**.

**"Installed" in Zed's UI therefore means "registry settings entry exists," not "a verified executable is present on disk."**

### Lazy materialization

The actual command resolution and artifact download happen later, when the agent needs to be launched:

- [`agent_server_store.rs:271-488`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/project/src/agent_server_store.rs#L271-L488) — `reregister_agents` observes settings changes and creates `LocalRegistryArchiveAgent` or `LocalRegistryNpxAgent` entries.
- [`agent_server_store.rs:1117-1326`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/project/src/agent_server_store.rs#L1117-L1326) — `LocalRegistryArchiveAgent.get_command` downloads and extracts the archive at launch time.
- [`agent_server_store.rs:1338-1418`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/project/src/agent_server_store.rs#L1338-L1418) — `LocalRegistryNpxAgent.get_command` constructs an `npm exec` command at launch time.

Zed's npm path uses a bounded version range (`0.0.0 - <version>`) rather than an exact package pin: [`agent_server_store.rs:1431-1460`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/project/src/agent_server_store.rs#L1431-L1460).

---

## 2. Agent Process Launch

When a thread is opened, Zed starts the ACP process:

- [`custom.rs:193-280`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/custom.rs#L193-L280) — `CustomAgentServer::connect` reads settings, builds environment, and launches.
  - Adds `NO_BROWSER=1` when the project is remote/browserless.
  - For Codex: forwards `CODEX_API_KEY` and `OPEN_AI_API_KEY` from Zed's host environment (note: `OPEN_AI_API_KEY` vs Codex's `OPENAI_API_KEY` spelling).
- [`acp.rs:796-955`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L796-L955) — `AcpConnection::stdio` spawns the child over stdin/stdout/stderr.

---

## 3. ACP initialize

- [`acp.rs:756-784`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L756-L784) — client capabilities sent to the agent.
- [`acp.rs:972-1094`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L972-L1094) — `initialize` request and response handling.

Zed stores the agent's advertised `authMethods` **as available choices**, not as proof that the agent is unauthenticated.

---

## 4. session/new — The Real Auth Gate

- [`acp.rs:1582-1689`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L1582-L1689) — `AcpConnection::new_session`.
- [`conversation_view.rs:1023-1217`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/conversation_view.rs#L1023-L1217) — `initial_state` awaits connection, then chooses load/resume/new.
- [`conversation_view.rs:1149-1159`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/conversation_view.rs#L1149-L1159) — if `session/new` returns an `AuthRequired` error, Zed transitions to unauthenticated state.
- [`conversation_view.rs:1432-1477`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/conversation_view.rs#L1432-L1477) — `handle_auth_required` sets `AuthState::Unauthenticated` on the connected server state.

ACP error mapping:

- [`acp.rs:2055-2066`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L2055-L2066) — `map_acp_error` preserves the `AuthRequired` typed error with description.

```text
Registry install (settings entry)
    |
    v
User starts thread
    |
    v
ACP process spawn
    |
    v
initialize
    |
    v
session/new
    |
    +-- success --> create thread view, auth state = Ok
    |
    +-- AuthRequired --> auth state = Unauthenticated, show auth UI
```

---

## 5. Authentication Methods

The `AgentConnection` trait exposes:

- [`connection.rs:167`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/acp_thread/src/connection.rs#L167) — `auth_methods() -> &[acp::AuthMethod]`
- [`connection.rs:171`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/acp_thread/src/connection.rs#L171) — `terminal_auth_task()`
- [`connection.rs:177`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/acp_thread/src/connection.rs#L177) — `authenticate(method_id)`

### Agent-managed auth

Zed sends the raw ACP `authenticate` request:

- [`acp.rs:1905-1913`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L1905-L1913) — sends `AuthenticateRequest { methodId }` and awaits response.

The agent owns the login flow entirely.

### Terminal auth

Zed spawns the agent command in a terminal with additional args/env from the method:

- [`acp.rs:1517-1566`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L1517-L1566) — terminal auth task construction.
- [`acp.rs:1868-1902`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L1868-L1902) — `terminal_auth_task` implementation.

### Auth UI

- [`conversation_view.rs:1895-2033`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/conversation_view.rs#L1895-L2033) — `authenticate` method in ConversationView. After success, calls `reset()` which attempts session creation again.
- [`conversation_view.rs:2232-2338`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/conversation_view.rs#L2232-L2338) — `render_auth_required_state`.

### Auth error during an established session

- [`acp.rs:1933-1991`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/acp.rs#L1933-L1991) — prompt handler that maps `ErrorCode::AuthRequired` from ACP.
- [`thread_view.rs:10948-10965`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/conversation_view/thread_view.rs#L10948-L10965) — `render_authentication_required_error`.
- [`thread_view.rs:11158-11183`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_ui/src/conversation_view/thread_view.rs#L11158-L11183) — the Authenticate button restores the in-flight prompt to the editor, then delegates to `ConversationView::handle_auth_required`.

---

## 6. Codex Authentication

Two relevant implementations exist.

### Older Zed-maintained Rust adapter

- Repo: `zed-industries/codex-acp`
- Commit: `af1dcbd` (2026-06-22)
- Cargo.toml version: `0.16.0`

**Auth methods (old):**

```text
chatgpt       -> AuthMethod::Agent     -> browser login
codex-api-key -> AuthMethod::EnvVar    -> read CODEX_API_KEY from env
openai-api-key -> AuthMethod::EnvVar   -> read OPENAI_API_KEY from env
```

- [`codex_agent.rs:439-477`](https://github.com/zed-industries/codex-acp/blob/af1dcbda1db5c5fb4ae30178a6f93286667f152d/src/codex_agent.rs#L439-L477) — `initialize` advertises auth methods and uses `NO_BROWSER` to remove ChatGPT.
- [`codex_agent.rs:479-544`](https://github.com/zed-industries/codex-acp/blob/af1dcbda1db5c5fb4ae30178a6f93286667f152d/src/codex_agent.rs#L479-L544) — `authenticate` reads the key from ACP process environment.
- [`codex_agent.rs:323-332`](https://github.com/zed-industries/codex-acp/blob/af1dcbda1db5c5fb4ae30178a6f93286667f152d/src/codex_agent.rs#L323-L332) — `check_auth` runs before `new_session`, `load_session`, `resume_session`, `list_sessions`, and `prompt`.
- [`codex_agent.rs:847-906`](https://github.com/zed-industries/codex-acp/blob/af1dcbda1db5c5fb4ae30178a6f93286667f152d/src/codex_agent.rs#L847-L906) — `CodexAuthMethod` enum and ACP method conversion.

The old API-key flow:

```text
authenticate(methodId = "codex-api-key")
    |
    v
read CODEX_API_KEY from process environment
    |
    +-- missing --> "CODEX_API_KEY is not set" (ACP internal error)
    |
    +-- present --> write native Codex auth state via login_with_api_key
```

The auth manager is initialized with environment-key loading disabled (`false` parameter):

- [`codex_agent.rs:71-83`](https://github.com/zed-industries/codex-acp/blob/af1dcbda1db5c5fb4ae30178a6f93286667f152d/src/codex_agent.rs#L71-L83)

So `check_auth` does not automatically activate a `CODEX_API_KEY` from the environment. The `authenticate` RPC must be invoked.

### Current official TypeScript adapter

- Repo: `agentclientprotocol/codex-acp`
- Commit: `2524dfb` (2026-07-21)
- npm: `@agentclientprotocol/codex-acp@1.1.5`

**Auth methods (current):**

```text
api-key     -> no standard ACP type (no "type": "env_var")
chat-gpt    -> legacy agent-managed
gateway     -> only if client opts in via clientCapabilities.auth._meta.gateway
```

- [`CodexAuthMethod.ts:4-5`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAuthMethod.ts#L4-L5) — `CODEX_API_KEY_ENV_VAR`, `OPENAI_API_KEY_ENV_VAR` constants.
- [`CodexAuthMethod.ts:60-69`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAuthMethod.ts#L60-L69) — `getCodexAuthMethods` uses `NO_BROWSER` to remove ChatGPT.
- [`CodexAcpClient.ts:109-170`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAcpClient.ts#L109-L170) — `authenticate`:
  - For `api-key`: reads key from `AuthenticateRequest._meta["api-key"].apiKey`, then falls back to `readApiKeyFromEnv` which reads `CODEX_API_KEY` then `OPENAI_API_KEY`.
  - For `chat-gpt`: reads account, starts login if needed, opens the auth URL in a browser.
  - For `gateway`: stores a gateway configuration.
- [`CodexAcpClient.ts:149-157`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAcpClient.ts#L149-L157) — `authenticateWithApiKey`.
- [`CodexAcpClient.ts:159-169`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAcpClient.ts#L159-L169) — `readApiKeyFromEnv` checks `CODEX_API_KEY`, then `OPENAI_API_KEY`, throws `"CODEX_API_KEY or OPENAI_API_KEY is not set"`.
- [`CodexAcpClient.ts:220-231`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAcpClient.ts#L220-L231) — `authRequired` checks the Codex App Server account state.
- [`CodexAcpServer.ts:293-307`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAcpServer.ts#L293-L307) — `checkAuthorization` calls `authRequired()`. If auth is needed and no `DEFAULT_AUTH_REQUEST` was provided, returns ACP `AuthRequired`.
- [`CodexAcpServer.ts:395-490`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAcpServer.ts#L395-L490) — `tryCreateSession` (used by `newSession`, `loadSession`, `resumeSession`) all call `checkAuthorization()`.
- [`CodexAcpServer.ts:207-252`](https://github.com/agentclientprotocol/codex-acp/blob/2524dfb8568eeac659353ca9705e73501bb403c8/src/CodexAcpServer.ts#L207-L252) — `initialize` returns auth methods via `getCodexAuthMethods()`.

Current Codex flow:

```text
initialize
    |
    v
session/new
    |
    +-- Codex account exists (authRequired = false) --> session created
    |
    +-- no account (authRequired = true) --> ACP AuthRequired
```

Auth methods are always advertised regardless of current authentication state.

The current adapter does **not** use the standardized ACP `"type": "env_var"` representation for its API-key method. The Auth RFD specification for `env_var` includes `vars`, `link`, and typed `AuthEnvVar` entries with `secret` and `optional` fields, but the current Codex adapter does not follow this convention yet.

---

## 7. Zed Agent-Specific Environment Forwarding

For Codex specifically, Zed forwards:

- [`custom.rs:225-246`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/agent_servers/src/custom.rs#L225-L246)

```rust
CODEX_ID => {
    if let Ok(api_key) = std::env::var("CODEX_API_KEY") {
        extra_env.insert("CODEX_API_KEY".into(), api_key);
    }
    if let Ok(api_key) = std::env::var("OPEN_AI_API_KEY") {
        extra_env.insert("OPEN_AI_API_KEY".into(), api_key);
    }
}
```

Notable: Zed's forwarding reads `OPEN_AI_API_KEY` (with underscore), while Codex's native environment variables use `OPENAI_API_KEY` (without underscore). This inconsistency means Codex may not see the forwarded key unless the user's session already has the correctly-named variable.

`NO_BROWSER=1` is also added for remote/headless environments:

- [`agent_server_store.rs:682-685`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/project/src/agent_server_store.rs#L682-L685) — `extra_env.insert("NO_BROWSER", "1")` when `no_browser()` is true.
- [`agent_server_store.rs:594-603`](https://github.com/zed-industries/zed/blob/4ebc1545d299b1270bc76813fa841357ee711b19/crates/project/src/agent_server_store.rs#L594-L603) — `no_browser` returns true for a local project with a downstream remote client lacking WSL interop.

---

## 8. Zed vs Marshal: Key Differences

| Aspect | Zed | Marshal (Current) | Marshal (Should) |
|---|---|---|---|
| **"Installed" meaning** | Registry settings entry exists | Pinned launch spec is materialized | Same as current — stronger than Zed |
| **Auth methods → state** | Available transitions, not state | Treated as proof of being unauthenticated | Should be transitions, not state |
| **Probe uses `session/new`** | Yes, to determine auth state | No, uses `authMethods.length > 0` | Yes |
| **Runtime auth error** | AuthRequired callout + prompt restore | Generic error + Retry button | Should be actionable auth callout |
| **Env-var auth flow** | Possible through terminal auth or env forwarding | Not implemented (blocks non-agent methods) | Architecture calls for it |
| **`_meta` preservation** | Retains raw ACP payload | Normalized away | Should preserve for extensibility |

---

## 9. Implications for Marshal

### P0: Readiness probe bug

`src/acp/probe.ts:27-32` currently returns `authentication_required` when `authMethods` is non-empty, without testing `session/new`. This means Codex will never reach `ready` through the normal probe flow, because Codex always advertises auth methods even when already authenticated.

The probe should:

1. Send `initialize`.
2. Persist auth methods and capabilities.
3. Attempt `session/new`.
4. Return `authentication_required` only on ACP `AuthRequired`.
5. Return `ready` on success.

### P0: ACP error identity

Errors are reduced to `Error.message` in multiple places:

- `src/acp/supervisor.ts:84` — `errorMessage` helper.
- `src/acp/supervisor.ts:70-78` — prompt catch clause.
- `src/agent/sdk-adapter.ts:365-366` — `errorMessage` helper.

ACP errors with `ErrorCode::AuthRequired` should be preserved as typed errors so the supervisor and UI can react appropriately.

### P1: Env-var auth support

Marshal's architecture already calls for env-var auth support:

> **Environment-variable auth** — Marshal collects or references required values and restarts the process with them.

The implementation needs:

- Structured auth method persistence (include `vars`, `link`, `_meta`).
- Web forms for declared env vars.
- Secret references (OS credential store).
- Environment injection on every agent launch.
- Process restart and reprobe after credential provisioning.

### P1: Runtime AuthRequired recovery

When `session/new` or `session/prompt` returns `AuthRequired`:

- Preserve the user's prompt.
- Mark the thread as auth-required rather than generic error.
- Present the selected agent's current auth methods.
- After successful auth, recreate/reload the ACP session.
- Allow the user to resubmit the preserved prompt.

### P2: Terminal auth

Some agents need a terminal-based login UX. The daemon should own a PTY and stream it to the browser. The terminal must run in the same environment as future agent processes (same machine, same env vars).

### P2: NO_BROWSER handling

Surface why a specific method is unavailable rather than silently hiding it.

---

## 10. Current Registry

The live ACP Registry (`https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`) as of 2026-07-22 shows `codex-acp` version `1.1.5` with distribution `@agentclientprotocol/codex-acp@1.1.5` (npx).

---

## 11. External Documentation

- [Zed External Agents](https://zed.dev/docs/ai/external-agents)
- [Zed Codex section](https://zed.dev/docs/ai/external-agents#codex-cli)
- [ACP Auth Methods RFD](https://agentclientprotocol.com/rfds/auth-methods)
- [ACP Protocol v1](https://agentclientprotocol.com/protocol/v1/schema)
- [Codex ACP README](https://github.com/agentclientprotocol/codex-acp)
