# ADR-0009: Guided Agent Activation

**Status:** Proposed  
**Date:** 2026-07-21  
**Parent:** ADR-0006  
**Related:** ADR-0005, ADR-0007, ADR-0008

---

## Context

The Agents page currently leaves a successful installation in an unknown
readiness state. The user must click **Probe readiness** before Marshal learns
whether the agent requires authentication, so the **Authenticate** action does
not appear until after an unexplained diagnostic step.

ACP initialization and a probe session are necessary: registry metadata cannot
prove that an installed launch specification starts, negotiates ACP, is
authenticated, or can create a session. Requiring the user to initiate that
check separately is not necessary and makes installation feel incomplete.

---

## Decision

Marshal will present installation and activation as one guided product flow
while retaining installation, authentication, and readiness as separate
daemon-owned states and trust transitions.

After an installation or update is published, Marshal will automatically run a
bounded readiness probe:

```text
install -> probe -> ready
                 -> authentication required -> authenticate -> probe -> ready
                 -> failed -> actionable retry
```

- If the probe succeeds, the agent is shown as ready without another action.
- If ACP advertises authentication methods, the UI immediately presents the
  supported login choice and explains what it will do.
- Authentication remains an explicit user action because it may open a browser,
  access an account, request credentials, or invoke another agent-owned flow.
- After successful authentication, Marshal automatically probes again.
- The primary UI will use user-oriented states such as **Checking agent**,
  **Sign in required**, **Ready**, and **Setup failed**.
- Manual **Probe readiness** becomes a secondary **Retry readiness check** or
  diagnostics action rather than a normal onboarding step.
- Failures distinguish missing host prerequisites from agent failures. For
  example, an `npx` distribution requires `npx`, but does not require the agent
  package to be globally installed; binary distributions are launched from
  Marshal-owned installation material.

Automatic probing does not assign the agent to a repository or workflow and
does not authorize unattended execution.

---

## Consequences

### Positive

- Installing an agent leads directly to either ready, sign-in-required, or an
  actionable failure state.
- Users no longer need to understand ACP initialization or readiness probing.
- Authentication consent and later assignment trust boundaries remain explicit.
- Missing package runners and launch failures become part of installation setup
  diagnostics instead of appearing during first use.

### Negative / Risks

- Installation operations take longer because activation includes process
  startup and ACP negotiation.
- Automatic process launch must be clearly covered by the pre-install trust
  confirmation that installing runs third-party code.
- Probe and authentication progress must remain durable across navigation and
  daemon restart.

---

## Alternatives considered

1. **Keep readiness probing as a required button.** Rejected. It exposes an
   internal lifecycle mechanism and hides the next useful action.
2. **Authenticate automatically whenever a method is advertised.** Rejected.
   Authentication is a separate account and credential trust transition.
3. **Treat successful installation as ready.** Rejected. Installation alone
   cannot prove ACP compatibility, authentication, or session creation.
