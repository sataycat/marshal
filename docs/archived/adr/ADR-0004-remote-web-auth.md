# ADR-0004: Authenticated Remote Web Access

**Status:** Completed 
**Date:** 2026-07-17  
**Parent:** —  
**Children:** ADR-0004a (device pairing and private relay, deferred)

---

## Context

Marshal's daemon serves the web application, HTTP API, and WebSocket event stream from one Node server. The API can create tasks, invoke agents, upload files, stream agent output, and merge branches. A listener reachable from a network is therefore an RCE-capable control plane, not an ordinary static web server.

Marshal already binds to `127.0.0.1` by default and supports an explicitly requested non-loopback host through `marshal start --host <addr>`. The current non-loopback path only logs a warning because the daemon has no authentication layer. That is insufficient for the target deployment: run Marshal on a VPS and access its web UI securely over the internet, using the same basic model as OpenChamber.

The target use case is a single human operator accessing one Marshal instance from a browser. Device pairing, multi-device management, passkeys, and a private relay are useful future capabilities but are not required to make the first remote deployment usable.

### Security boundary

Authentication protects the daemon's HTTP and WebSocket control plane from unauthorised network clients. It does not sandbox ACP agents. An authenticated request can still cause an agent to read files, execute commands, and modify the host according to the configured agent policy. VPS operators remain responsible for process user permissions, agent isolation, firewalling, and HTTPS or a trusted private network.

---

## Decision

Add OpenChamber-style password authentication for deliberately exposed Marshal web servers while preserving unauthenticated localhost development.

### 1. Localhost remains the default

The default bind remains:

```text
127.0.0.1:7433
```

No password is required for a loopback-only daemon unless the operator explicitly configures authentication. Existing local CLI and development workflows must continue to work without a login step.

### 2. Remote serving is an explicit mode

Marshal will support a deliberate LAN/remote bind, with a convenience flag matching the intended deployment vocabulary:

```sh
marshal start --lan --password 'use-a-long-random-password' --port 7433
```

`--lan` resolves to `0.0.0.0`. The existing `--host` option remains available for binding to a specific interface, such as a VPN address. If both are supplied, the CLI rejects the combination rather than guessing.

Non-loopback binds require a configured UI password. Daemon startup fails closed when remote serving is requested without one:

```text
LAN access requires a UI password.
Provide --password, set MARSHAL_UI_PASSWORD, or configure daemon.uiPassword.
```

The password may be supplied through `--password`, an environment variable, or an equivalent secret-management mechanism. Environment/configuration input is preferred for unattended deployments because process arguments can be visible to other users through system tools.

Example VPS launch:

```sh
MARSHAL_UI_PASSWORD='use-a-long-random-password' \
  marshal start --lan --port 7433
```

### 3. Login creates a browser session

The web UI presents a password login screen when authentication is enabled. A successful login creates an opaque authenticated session represented by an `HttpOnly` cookie. The password is not stored in browser storage and is not sent with subsequent requests.

The session cookie has these properties:

- `HttpOnly`
- `Path=/`
- `SameSite=Strict` or the strongest compatible same-site setting
- `Secure` when the request is served over HTTPS
- Explicit expiry and idle/absolute session lifetime

The server stores only password-verification material, never the plaintext password. The initial implementation should use Node's built-in `crypto.scrypt` with a random salt and constant-time comparison. Session tokens must be generated with a cryptographically secure random source.

### 4. Protect the backend, not necessarily the SPA shell

Authentication middleware protects all stateful and sensitive HTTP API routes, including:

- Task creation, transitions, freeze, and merge
- Specs, spec chat, and chat turns
- Attachments and file reads
- Run records and run events
- Any future route that can invoke an agent or mutate repository state

`/api/auth/status` and `POST /api/auth/login` remain available without an established session. `/api/auth/logout` is available to an authenticated session. `/api/health` may remain unauthenticated for basic process monitoring, but must not expose secrets, configuration, task data, or agent output.

The SPA shell may be served before authentication so the browser can load the login UI. Loading `/` is not considered authenticated access; all useful data and control operations remain behind the auth middleware.

### 5. Protect WebSocket upgrades

The `/ws` upgrade handler must validate the authenticated browser session before accepting the connection. A client without a valid session is rejected during the HTTP upgrade and must not receive the initial task/thread snapshot or subsequent run events.

The server also validates the request `Origin` for browser requests. Allowed origins are the daemon's own origin and explicitly configured reverse-proxy origins. Cross-origin wildcard access is not part of this decision.

### 6. Rate-limit password attempts

The login endpoint uses a bounded per-client rate limiter with temporary lockout after repeated failures. Responses include `Retry-After` when locked out. The implementation must avoid trusting arbitrary forwarded headers unless the operator explicitly configures a trusted reverse proxy.

The limiter is a defense against password guessing, not a replacement for HTTPS, VPN access, or firewall rules.

### 7. HTTPS and network placement remain deployment responsibilities

Marshal's built-in server remains HTTP. Production VPS deployments should place it behind HTTPS or expose it only through a private network/VPN such as Tailscale/WireGuard. The documentation will include reverse-proxy guidance for preserving WebSocket upgrades and forwarding the original protocol so `Secure` cookies work correctly.

The supported security posture is:

```text
Internet client
    -> HTTPS / VPN / authenticated tunnel
    -> Marshal password session
    -> Marshal HTTP + WebSocket API
    -> local ACP agent process
```

Directly publishing an unauthenticated `0.0.0.0` listener is rejected by the daemon. Directly publishing a password-authenticated plain-HTTP listener is technically supported for trusted private networks but is not recommended for the public internet because the password and session cookie can be intercepted.

### 8. Keep future device access separate

Device pairing, per-device bearer tokens, revocation, passkeys, and a private relay are explicitly deferred to ADR-0004a. They must not weaken or bypass the browser session boundary introduced here.

The future relay may avoid inbound VPS ports, but it is not required for the first supported VPS deployment. The first milestone is one human operator using a password-authenticated browser session over an HTTPS reverse proxy or private VPN.

---

## Authentication surface

The first implementation should add the following conceptual routes:

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/auth/status` | Optional | Report whether authentication is enabled and whether this browser is authenticated. |
| POST | `/api/auth/login` | No | Verify password and issue session cookie. |
| POST | `/api/auth/logout` | Session | Revoke/clear the current browser session. |
| GET | `/api/health` | Optional | Minimal process health check. |
| GET | `/ws` | Session | Authenticated WebSocket event stream. |

The exact password storage and session persistence format may be finalized during implementation, provided the properties above hold. A restart may invalidate in-memory sessions; persistent sessions are not required for this ADR.

---

## Consequences

### Positive

- A Marshal instance can run on a VPS without exposing an unauthenticated RCE-capable API.
- The default localhost workflow remains frictionless.
- Browser UI, HTTP mutations, and WebSocket events share one clear authentication boundary.
- The design is compatible with reverse proxies, VPNs, and later private-relay access.
- The first remote milestone does not require a device registry or relay service.

### Negative / Risks

- Password authentication adds login state and frontend auth handling to the daemon.
- Cookie authentication requires careful WebSocket upgrade handling and origin checks.
- Plain HTTP remains unsafe on an untrusted network even when a password is configured.
- Authentication does not reduce the privileges of an authenticated ACP agent.
- In-memory sessions are lost on daemon restart unless a later implementation chooses persistence.

---

## Alternatives considered

1. **Keep non-loopback serving unauthenticated and rely only on firewalling.** Rejected. A firewall or private network is useful defense in depth but does not satisfy the requested password-protected browser deployment and makes accidental exposure catastrophic.

2. **HTTP Basic Auth.** Rejected. Browser session cookies provide a better UI flow, allow logout and expiry, avoid resending the password on every request, and match the OpenChamber model.

3. **Bearer token in every browser request.** Deferred. This is appropriate for future device clients, but browser-owned WebSocket connections cannot reliably attach arbitrary headers. Cookie sessions are the simpler primary browser mechanism.

4. **Implement private relay and device pairing first.** Deferred. Relay access is attractive and may become the preferred remote path, but it introduces a separate service, pairing protocol, device lifecycle, and operational surface. It is not necessary for a single-operator VPS deployment behind HTTPS or a VPN.

5. **Require authentication on localhost.** Rejected for the initial implementation. It would make local development and existing CLI workflows needlessly cumbersome. Operators can explicitly configure auth for loopback if desired.

---

## Implementation acceptance criteria

- `marshal start` binds to `127.0.0.1:7433` by default.
- `marshal start --lan --port 7433` refuses to start without a UI password and suggests `--password`.
- A configured password allows the SPA login flow to establish a session.
- Invalid passwords do not establish a session and are rate-limited.
- Unauthenticated clients receive `401` from protected API routes.
- Unauthenticated WebSocket upgrades to `/ws` are rejected.
- Authenticated WebSocket clients receive the normal connected snapshot and events.
- Logout invalidates the browser session.
- Passwords, session tokens, and agent data are not logged.
- Existing localhost API, WebSocket, CLI, and daemon tests remain green.
- Documentation includes HTTPS reverse-proxy/VPN guidance and reiterates that agent isolation is a separate concern.
