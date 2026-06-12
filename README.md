# clarinator

An interactive **clarify-before-you-code gate** for coding agents. The agent
computes a branching decision tree; clarinator serves it as a single-page UI on
loopback, **blocks** until you answer (revealing follow-up questions as you pick),
then prints the structured result to stdout for the agent to read.

Built to be run on demand — no install step in your project:

```bash
bunx est7/clarinator clarity up --input payload.json
```

Requires **bun** on the host (`curl -fsSL https://bun.sh/install | bash`).

## How it works

1. The agent writes a `ClarityPayload` (a decision page, see below) to a JSON file.
2. `clarinator clarity up --input payload.json` validates it, serves the
   prebuilt UI at `http://127.0.0.1:<random>/`, and opens your browser.
3. You answer. Each pick may reveal child questions gated by `show_if`; the page
   resolves the active set client-side — no round-trips.
4. You hit **Send to agent**. The server prints the result to stdout and exits.

For multi-page clarity flows, include `flow` metadata. `clarity up` starts the
session and waits for page 1. If the result says `action: "continue"`, the agent
generates the next page and runs:

```bash
bunx est7/clarinator clarity continue --input next-page.json
```

When the flow is complete or should be cancelled, close the session:

```bash
bunx est7/clarinator clarity down
```

Exit codes: `0` submitted · `2` usage/validation error · `3` cancelled · `4` timeout.

### CLI

```
clarinator --version
clarinator clarity up --input <payload.json> [--out <result.json>]
           [--timeout-ms 1800000] [--locale zh] [--no-open]
clarinator clarity continue --input <payload.json> [--out <result.json>]
clarinator clarity down
clarinator plan up --input <payload.json> [--out <result.json>]
clarinator plan down
```

`--input` defaults to stdin. The result is always printed to stdout; `--out`
additionally writes it to a file. UI chrome is localized via `--locale`
(`en` / `zh`, falls back to the browser language).

## Payload schema (`clarity` mode)

```jsonc
{
  "title": "Login PRD",
  "subtitle": "v1 · B2C",
  "context": "Email-first, magic-link primary. TTL / session model undecided.",
  "decisions": [
    {
      "id": "auth-method",
      "question": "Which auth methods for v1?",
      "recommendation_reason": "Spec twice says 'low friction' + B2C — magic link hits both.",
      "allow_custom": true,
      "options": [
        { "id": "magic-link", "label": "Magic link only", "recommended": true, "reason": "Lowest friction." },
        { "id": "password", "label": "Password + magic link", "recommended": false }
      ]
    },
    {
      "id": "password-strength",
      "question": "Password policy?",
      "recommendation_reason": "Only relevant once passwords are in scope.",
      "show_if": { "decision": "auth-method", "in": ["password"] },
      "options": [
        { "id": "lenient", "label": "Lenient", "recommended": true },
        { "id": "strict", "label": "Strict", "recommended": false }
      ]
    }
  ]
}
```

- A decision with `show_if` is **active** only when the referenced (earlier)
  decision's answer is one of `in[]`. Inactive decisions are hidden and excluded
  from the result. `show_if.decision` must reference an earlier decision → the
  tree is acyclic by construction.
- Exactly one option per decision must have `recommended: true`.
- `allow_custom: true` adds a free-text answer. A custom answer never satisfies an
  option-id `show_if` guard — if a free-text answer needs follow-ups the agent
  could not foresee, the agent runs a second clarinator round.

### Result

```jsonc
{
  "mode": "clarity",
  "title": "Login PRD",
  "action": "continue",
  "sessionId": "login-prd",
  "pageId": "entry-path",
  "result": [
    { "decisionId": "auth-method", "question": "…", "optionId": "magic-link", "answer": "Magic link only", "custom": false }
  ]
}
```

## Development

```bash
bun install
bun run dev          # vite dev server (hot reload)
bun run check        # typecheck + vitest (logic) + build + bun test (server)
```

- `src/reducer.ts` + `src/validate.ts` — the pure branching engine (vitest).
- `server/primitive.ts` — `startBlockingSingleSubmitServer`, a domain-free
  loopback blocking server (reused by future `plan` mode).
- `bin/clarinator.ts` — the CLI.
- `dist/app.html` — the committed prebuilt single-file UI. **Rebuild and
  commit it whenever `src/` changes** (`bun run build`).

## Plan mode

Step 2 of the SOP, reusing the same blocking primitive. The agent writes a
`PlanPayload` (`{ title, subtitle?, plan }` where `plan` is Markdown); clarinator
renders it into commentable blocks. You attach inline comments per block, add
overall feedback, and either **Approve** or **Request changes**.

```bash
bunx est7/clarinator plan up --input plan.json
```

Result:

```jsonc
{
  "mode": "plan",
  "title": "Login flow — implementation plan",
  "decision": "revise",
  "annotations": [
    { "blockIndex": 4, "quote": "## Risks", "comment": "also rate-limit /auth/request" }
  ],
  "generalFeedback": "tighten the token TTL"
}
```

Because the plan is derived from the agent's reasoning *after* clarity, Step 1 and
Step 2 are necessarily separate invocations: clarity blocks → exits → the agent
synthesizes the plan → plan blocks → exits. The agent orchestrates the handoff.
