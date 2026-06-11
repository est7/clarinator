# clarinator

An interactive **clarify-before-you-code gate** for coding agents. The agent
computes a branching decision tree; clarinator serves it as a single-page UI on
loopback, **blocks** until you answer (revealing follow-up questions as you pick),
then prints the structured result to stdout for the agent to read.

Built to be run on demand — no install step in your project:

```bash
bunx github:est7/clarinator --mode clarity --input payload.json
# or pin a version:
bunx github:est7/clarinator@v0.1.0 --mode clarity --input payload.json
```

Requires **bun** on the host (`curl -fsSL https://bun.sh/install | bash`).

## How it works

1. The agent writes a `ClarityPayload` (a decision tree, see below) to a JSON file.
2. `clarinator --mode clarity --input payload.json` validates it, serves the
   prebuilt UI at `http://127.0.0.1:<random>/`, and opens your browser.
3. You answer. Each pick may reveal child questions gated by `show_if`; the page
   resolves the active set client-side — no round-trips.
4. You hit **Send to agent**. The server prints the result to stdout and exits.

Exit codes: `0` submitted · `2` usage/validation error · `3` cancelled · `4` timeout.

### CLI

```
clarinator --mode clarity --input <payload.json> [--out <result.json>]
           [--timeout-ms 1800000] [--locale zh] [--no-open]
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
- `dist/clarity.html` — the committed prebuilt single-file UI. **Rebuild and
  commit it whenever `src/` changes** (`bun run build`).

## Roadmap

`--mode plan` (Step 2): render an agent's plan for inline review/annotation,
reusing the same blocking primitive.
