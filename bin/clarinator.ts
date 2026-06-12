#!/usr/bin/env bun
// clarinator CLI. Foreground, blocking: validate the payload, serve the committed
// single-file UI on loopback, block until the user submits/cancels (or it times
// out), print the structured result to stdout, exit. The agent reads stdout.
//
//   clarinator clarity up --input payload.json [--out answers.json]
//                  [--timeout-ms 1800000] [--locale zh] [--no-open]
//   clarinator clarity down
//   clarinator plan up --input payload.json [--out answers.json]
//   clarinator plan down
//
// Exit codes: 0 submitted · 2 usage/validation error · 3 cancelled · 4 timeout.

import { validatePayload, validatePlanPayload, ValidationError } from "../src/validate.ts";
import { buildResult, validateAnswers } from "../src/reducer.ts";
import { injectBootstrap } from "../src/bootstrapHtml.ts";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  Answer,
  Answers,
  Bootstrap,
  ClarityPayload,
  ClaritySubmission,
  PlanAnnotation,
  PlanPayload,
  PlanSubmission,
} from "../src/types.ts";
import { startBlockingSingleSubmitServer, type BlockingServerOptions } from "../server/primitive.ts";
// Embedded at build/compile time so the compiled binary is fully self-contained
// (no runtime dependency on a sibling dist/ directory). In source mode bun reads
// the committed dist/app.html at run time. `type: "text"` yields a string at
// runtime; bun's types annotate it as HTMLBundle, hence the cast.
import appHtmlRaw from "../dist/app.html" with { type: "text" };
const appHtml = appHtmlRaw as unknown as string;

type Mode = "clarity" | "plan";
type Action = "up" | "down";

interface Args {
  mode: Mode;
  action: Action;
  input?: string;
  out?: string;
  timeoutMs: number;
  locale?: string;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const [modeRaw, actionRaw] = argv;
  if (modeRaw !== "clarity" && modeRaw !== "plan") failUsage();
  if (actionRaw !== "up" && actionRaw !== "down") failUsage();

  const a: Args = { mode: modeRaw, action: actionRaw, timeoutMs: 30 * 60 * 1000, open: true };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${k}`);
      return v as string;
    };
    switch (k) {
      case "--input": a.input = next(); break;
      case "--out": a.out = next(); break;
      case "--timeout-ms": a.timeoutMs = Number(next()); break;
      case "--locale": a.locale = next(); break;
      case "--no-open": a.open = false; break;
      default: fail(`unknown argument: ${k}`);
    }
  }
  if (!Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) fail("--timeout-ms must be a positive number");
  if (a.action === "up" && !a.input) fail("up requires --input <payload.json>");
  if (a.action === "down" && (a.input || a.out || a.locale || !a.open || a.timeoutMs !== 30 * 60 * 1000)) {
    fail("down accepts no flags");
  }
  return a;
}

function failUsage(): never {
  fail("usage: clarinator <clarity|plan> <up|down> [--input payload.json] [--locale zh] [--timeout-ms ms] [--no-open]");
}

function fail(msg: string): never {
  process.stderr.write(`clarinator: ${msg}\n`);
  process.exit(2);
}

async function readInput(path: string | undefined): Promise<unknown> {
  const raw = path ? await Bun.file(path).text() : await Bun.stdin.text();
  if (!raw.trim()) fail("empty input payload");
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`input is not valid JSON: ${(e as Error).message}`);
  }
}

/** Keep only well-formed answers for known decisions — the server's trust gate. */
function sanitizeAnswers(payload: ClarityPayload, raw: unknown): Answers {
  const known = new Set(payload.decisions.map((d) => d.id));
  const out: Answers = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(id) || typeof val !== "object" || val === null) continue;
    const v = val as Record<string, unknown>;
    if (v.kind === "option" && typeof v.optionId === "string") {
      out[id] = { kind: "option", optionId: v.optionId } satisfies Answer;
    } else if (v.kind === "custom" && typeof v.value === "string") {
      out[id] = { kind: "custom", value: v.value } satisfies Answer;
    }
  }
  return out;
}

function inject(boot: Bootstrap): string {
  try {
    const html = injectBootstrap(appHtml, boot);
    if (!html.includes("<script>window.__CLARINATOR__")) fail("embedded UI bootstrap injection failed");
    return html;
  } catch {
    fail("embedded UI (dist/app.html) is missing or has no </head> sentinel — run `bun run build` before compiling");
  }
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === "darwin" ? ["open", url]
    : process.platform === "win32" ? ["cmd", "/c", "start", "", url]
    : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // Non-fatal: the URL is already printed to stderr.
  }
}

type Submission = ClaritySubmission | PlanSubmission;
type OnSubmit = BlockingServerOptions<Submission>["onSubmit"];

function prepareClarity(payload: ClarityPayload, token: string, locale?: string): { boot: Bootstrap; onSubmit: OnSubmit } {
  return {
    boot: { mode: "clarity", token, locale, payload },
    onSubmit: (body) => {
      const b = body as Record<string, unknown>;
      const action = b.action === "continue" ? "continue" : "done";
      if (action === "continue" && payload.flow === undefined) return { ok: false, error: "continue action requires payload.flow" };
      if (action === "done" && payload.flow?.allow_done === false) return { ok: false, error: "done action is disabled for this page" };
      const answers = sanitizeAnswers(payload, b.answers);
      const verdict = validateAnswers(payload, answers);
      if (!verdict.ok) return verdict;
      return {
        ok: true,
        result: {
          mode: "clarity",
          title: payload.title,
          action,
          ...(payload.flow?.session_id ? { sessionId: payload.flow.session_id } : {}),
          ...(payload.flow?.page_id ? { pageId: payload.flow.page_id } : {}),
          result: buildResult(payload, answers),
        },
      };
    },
  };
}

/** Keep only well-formed annotations — the server's trust gate for plan mode. */
function sanitizeAnnotations(raw: unknown): PlanAnnotation[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanAnnotation[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const a = item as Record<string, unknown>;
    if (
      typeof a.blockIndex === "number" &&
      Number.isInteger(a.blockIndex) &&
      a.blockIndex >= 0 &&
      typeof a.comment === "string" &&
      a.comment.trim()
    ) {
      out.push({
        blockIndex: a.blockIndex,
        // quote is a client-provided excerpt for the agent's convenience; cap it.
        quote: typeof a.quote === "string" ? a.quote.slice(0, 200) : "",
        comment: a.comment.trim(),
      });
    }
  }
  return out;
}

function preparePlan(payload: PlanPayload, token: string, locale?: string): { boot: Bootstrap; onSubmit: OnSubmit } {
  return {
    boot: { mode: "plan", token, locale, payload },
    onSubmit: (body) => {
      const b = body as Record<string, unknown>;
      if (b.decision !== "approve" && b.decision !== "revise") return { ok: false, error: "decision must be approve|revise" };
      const general = typeof b.generalFeedback === "string" && b.generalFeedback.trim() ? b.generalFeedback.trim() : undefined;
      return {
        ok: true,
        result: {
          mode: "plan",
          title: payload.title,
          decision: b.decision,
          annotations: sanitizeAnnotations(b.annotations),
          ...(general ? { generalFeedback: general } : {}),
        },
      };
    },
  };
}

async function prepare(args: Args, token: string): Promise<{ boot: Bootstrap; onSubmit: OnSubmit }> {
  const raw = await readInput(args.input);
  try {
    if (args.mode === "clarity") return prepareClarity(validatePayload(raw), token, args.locale);
    if (args.mode === "plan") return preparePlan(validatePlanPayload(raw), token, args.locale);
  } catch (e) {
    if (e instanceof ValidationError) fail(`payload validation failed: ${e.message}`);
    throw e;
  }
  return fail(`unknown mode ${JSON.stringify(args.mode)}`);
}

interface SessionState {
  mode: Mode;
  url: string;
  token: string;
  pid: number;
  startedAt: string;
}

function stateDir(): string {
  return process.env.CLARINATOR_STATE_DIR || join(homedir(), ".cache", "clarinator", "state");
}

function statePath(mode: Mode): string {
  return join(stateDir(), `${mode}.json`);
}

async function readState(mode: Mode): Promise<SessionState | null> {
  try {
    return JSON.parse(await readFile(statePath(mode), "utf8")) as SessionState;
  } catch (e) {
    if (e && typeof e === "object" && "code" in e && (e as { code?: string }).code === "ENOENT") return null;
    await rm(statePath(mode), { force: true });
    fail(`${mode} session state was invalid and has been removed`);
  }
}

async function writeState(state: SessionState): Promise<void> {
  await mkdir(stateDir(), { recursive: true, mode: 0o700 });
  await writeFile(statePath(state.mode), JSON.stringify(state, null, 2), { mode: 0o600 });
}

async function clearState(mode: Mode, pid?: number): Promise<void> {
  if (pid !== undefined) {
    const current = await readState(mode);
    if (current && current.pid !== pid) return;
  }
  await rm(statePath(mode), { force: true });
}

async function runDown(mode: Mode): Promise<never> {
  const state = await readState(mode);
  if (!state) {
    process.stderr.write(`clarinator: no active ${mode} session\n`);
    process.exit(0);
  }

  let res: Response;
  try {
    res = await fetch(new URL("api/cancel", state.url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: state.token }),
    });
  } catch {
    await clearState(mode, state.pid);
    process.stderr.write(`clarinator: removed stale ${mode} session\n`);
    process.exit(0);
  }

  if (res.status === 403) fail(`${mode} session rejected cancel token`);
  if (!res.ok) fail(`${mode} cancel failed with HTTP ${res.status}`);
  await clearState(mode, state.pid);
  process.stderr.write(`clarinator: ${mode} session cancelled\n`);
  process.exit(0);
}

async function runUp(args: Args): Promise<never> {
  const token = crypto.randomUUID();
  const { boot, onSubmit } = await prepare(args, token);
  const html = inject(boot);

  const server = startBlockingSingleSubmitServer<Submission>({ html, token, timeoutMs: args.timeoutMs, onSubmit });
  const cleanup = async () => {
    await clearState(args.mode, process.pid);
    await server.stop();
  };

  process.on("SIGINT", () => {
    cleanup().finally(() => process.exit(130));
  });
  process.on("SIGTERM", () => {
    cleanup().finally(() => process.exit(143));
  });

  await writeState({ mode: args.mode, url: server.url, token, pid: process.pid, startedAt: new Date().toISOString() });
  process.stderr.write(`clarinator: review at ${server.url}\n`);
  if (args.open) openBrowser(server.url);

  const outcome = await server.done;
  // Graceful stop drains the in-flight submit/cancel ACK before closing, so the
  // browser reliably shows its end screen. The small sleep only lets the browser
  // paint that screen; correctness comes from the graceful drain, not the timing.
  await Bun.sleep(150);
  await cleanup();

  if (outcome.status === "submitted") {
    const text = JSON.stringify(outcome.result, null, 2);
    if (args.out) await Bun.write(args.out, text);
    process.stdout.write(text + "\n");
    process.exit(0);
  }
  if (outcome.status === "error") {
    process.stderr.write(`clarinator: internal error handling submission: ${outcome.error}\n`);
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({ status: outcome.status }) + "\n");
  process.exit(outcome.status === "cancelled" ? 3 : 4);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.action === "down") await runDown(args.mode);
  await runUp(args);
}

main();
