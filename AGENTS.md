# Repository Guidelines

## Project Structure & Module Organization

`clarinator` is a Bun-powered TypeScript CLI plus a Vite/React single-page UI. Browser and shared logic lives in `src/`: `src/clarity/` and `src/plan/` contain mode-specific apps, `src/components/` holds reusable UI, and `src/reducer.ts` plus `src/validate.ts` contain pure decision-tree behavior. The executable entrypoint is `bin/clarinator.ts`; the loopback server is in `server/primitive.ts`. Example payloads live in `examples/`. The built UI is committed as `dist/app.html`; rebuild and commit it whenever `src/` UI code changes.

## Build, Test, and Development Commands

Use Bun 1.3.x (`packageManager` is `bun@1.3.14`).

- `bun install` installs development dependencies.
- `bun run dev` starts the Vite dev server for UI work.
- `bun run serve -- --mode clarity --input examples/clarity-sample.json` runs the CLI.
- `bun run typecheck` runs strict TypeScript checks.
- `bun run test` runs Vitest tests under `src/**/*.test.ts(x)`.
- `bun run test:server` runs Bun tests in `tests/`.
- `bun run build` writes `dist/app.html` via Vite single-file output.
- `bun run check` is the full local gate: typecheck, Vitest, build, then server tests.

## Coding Style & Naming Conventions

Write TypeScript as ES modules with explicit `.ts` imports for local modules. Match the existing style: two-space indentation, double quotes, semicolons, strict types, and small pure helpers near callers. Use PascalCase for React components and exported types, camelCase for functions and variables, and kebab-case for CLI flags. Keep comments focused on contracts and non-obvious behavior.

## Testing Guidelines

Put pure UI/shared logic tests beside source files as `*.test.ts` or `*.test.tsx`; these run in Vitest with `happy-dom`. Put CLI/server integration tests in `tests/`; these run with `bun test`. When changing payload validation, branching, submission handling, or exit behavior, add or update tests before relying on manual browser checks. Run `bun run check` before handing off changes that touch executable code.

## Commit & Pull Request Guidelines

The repository history uses Conventional Commit-style subjects, for example `feat: add plan mode` and `fix: actually ship dist/app.html`. Keep commits narrow and include generated `dist/app.html` only when the source change requires it. Pull requests should describe user-visible behavior, list verification commands, link related issues when available, and include screenshots or short recordings for UI changes.

## Security & Configuration Tips

The CLI serves only on loopback and gates submissions with a token. Do not weaken that boundary casually. Avoid runtime dependencies in the published CLI path; React, Vite, and `marked` are build-time dependencies for the committed UI artifact.
