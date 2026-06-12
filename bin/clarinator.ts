#!/usr/bin/env bun
// clarinator CLI. Foreground, blocking: validate the payload, serve the committed
// single-file UI on loopback, block until the user submits/cancels (or it times
// out), print the structured result to stdout, exit. The agent reads stdout.
//
//   clarinator clarity up --input payload.json [--out answers.json]
//                  [--timeout-ms 1800000] [--locale zh] [--no-open]
//   clarinator clarity continue --input next-page.json
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
import { startBlockingSingleSubmitServer, type BlockingServerOptions, type SubmitOutcome } from "../server/primitive.ts";
// Embedded at build/compile time so the compiled binary is fully self-contained
// (no runtime dependency on a sibling dist/ directory). In source mode bun reads
// the committed dist/app.html at run time. `type: "text"` yields a string at
// runtime; bun's types annotate it as HTMLBundle, hence the cast.
import appHtmlRaw from "../dist/app.html" with { type: "text" };
const appHtml = appHtmlRaw as unknown as string;

type Mode = "clarity" | "plan";
type Action = "up" | "continue" | "down" | "serve-flow";

interface Args {
  mode: Mode;
  action: Action;
  input?: string;
  out?: string;
  timeoutMs: number;
  locale?: string;
  open: boolean;
  token?: string;
}

function parseArgs(argv: string[]): Args {
  const [modeRaw, actionRaw] = argv;
  if (modeRaw !== "clarity" && modeRaw !== "plan") failUsage();
  if (actionRaw !== "up" && actionRaw !== "continue" && actionRaw !== "down" && actionRaw !== "serve-flow") failUsage();

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
      case "--token": a.token = next(); break;
      case "--no-open": a.open = false; break;
      default: fail(`unknown argument: ${k}`);
    }
  }
  if (!Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) fail("--timeout-ms must be a positive number");
  if ((a.action === "up" || a.action === "continue" || a.action === "serve-flow") && !a.input) {
    fail(`${a.action} requires --input <payload.json>`);
  }
  if (a.action === "continue" && a.mode !== "clarity") fail("continue is only supported for clarity flow sessions");
  if (a.action === "serve-flow" && (a.mode !== "clarity" || !a.token)) fail("serve-flow is internal and requires clarity + --token");
  if (a.action === "down" && (a.input || a.out || a.locale || a.token || !a.open || a.timeoutMs !== 30 * 60 * 1000)) {
    fail("down accepts no flags");
  }
  if (a.mode === "plan" && (a.action === "continue" || a.action === "serve-flow")) fail(`${a.action} is not supported for plan`);
  return a;
}

function failUsage(): never {
  fail("usage: clarinator <clarity|plan> <up|continue|down> [--input payload.json] [--locale zh] [--timeout-ms ms] [--no-open]");
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

function buildClaritySubmission(payload: ClarityPayload, body: unknown): { ok: true; result: ClaritySubmission } | { ok: false; error: string } {
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
}

function prepareClarity(payload: ClarityPayload, token: string, locale?: string): { boot: Bootstrap; onSubmit: OnSubmit } {
  return {
    boot: { mode: "clarity", token, locale, payload },
    onSubmit: (body) => buildClaritySubmission(payload, body),
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

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function readClarityPayload(path: string | undefined): Promise<ClarityPayload> {
  const raw = await readInput(path);
  try {
    return validatePayload(raw);
  } catch (e) {
    if (e instanceof ValidationError) fail(`payload validation failed: ${e.message}`);
    throw e;
  }
}

async function postJson(url: URL, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForState(mode: Mode, pid: number): Promise<SessionState> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const state = await readState(mode);
    if (state?.pid === pid) return state;
    await Bun.sleep(50);
  }
  fail(`timed out waiting for ${mode} session to start`);
}

async function waitForFlowResult(state: SessionState, seq: number, out?: string): Promise<never> {
  const res = await postJson(new URL("api/result", state.url), { token: state.token, seq });
  if (res.status === 403) fail("clarity session rejected result token");
  if (!res.ok) fail(`clarity result failed with HTTP ${res.status}`);
  const outcome = await res.json();
  if (!outcome || typeof outcome !== "object" || !("status" in outcome)) fail("clarity result returned invalid outcome");
  if (outcome.status !== "submitted") {
    process.stdout.write(JSON.stringify(outcome) + "\n");
    process.exit(outcome.status === "cancelled" ? 3 : 4);
  }
  const result = (outcome as { result: unknown }).result;
  const text = JSON.stringify(result, null, 2);
  if (out) await Bun.write(out, text);
  process.stdout.write(text + "\n");
  process.exit(0);
}

async function runFlowUp(args: Args, payload: ClarityPayload): Promise<never> {
  if (!payload.flow) fail("clarity flow up requires payload.flow");
  await clearState("clarity");
  const token = crypto.randomUUID();
  const cmd: string[] = [
    "bun",
    Bun.argv[1]!,
    "clarity",
    "serve-flow",
    "--input",
    args.input!,
    "--token",
    token,
    "--timeout-ms",
    String(args.timeoutMs),
    ...(args.locale ? ["--locale", args.locale] : []),
    ...(args.open ? [] : ["--no-open"]),
  ];
  const child = Bun.spawn(cmd, {
    cwd: process.cwd(),
    env: process.env,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  (child as unknown as { unref?: () => void }).unref?.();
  const state = await waitForState("clarity", child.pid);
  await waitForFlowResult(state, 1, args.out);
  process.exit(0);
}

async function runContinue(args: Args): Promise<never> {
  const state = await readState("clarity");
  if (!state) fail("no active clarity session");
  const payload = await readClarityPayload(args.input);
  if (!payload.flow) fail("clarity continue requires payload.flow");
  const res = await postJson(new URL("api/continue", state.url), { token: state.token, payload, locale: args.locale });
  if (res.status === 403) fail("clarity session rejected continue token");
  if (!res.ok) fail(`clarity continue failed with HTTP ${res.status}`);
  const body = (await res.json()) as { seq?: unknown };
  if (typeof body.seq !== "number") fail("clarity continue returned no page sequence");
  await waitForFlowResult(state, body.seq, args.out);
  process.exit(0);
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

async function runServeFlow(args: Args): Promise<never> {
  const token = args.token!;
  let payload = await readClarityPayload(args.input);
  if (!payload.flow) fail("clarity flow session requires payload.flow");
  let seq = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const waiters = new Map<number, (value: SubmitOutcome<ClaritySubmission>) => void>();
  const results = new Map<number, SubmitOutcome<ClaritySubmission>>();

  const boot = (): Bootstrap => ({ mode: "clarity", token, locale: args.locale, payload });

  const resolveSeq = (n: number, outcome: SubmitOutcome<ClaritySubmission>) => {
    if (results.has(n)) return;
    results.set(n, outcome);
    waiters.get(n)?.(outcome);
    waiters.delete(n);
  };

  const waitSeq = (n: number): Promise<SubmitOutcome<ClaritySubmission>> => {
    const existing = results.get(n);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.set(n, resolve));
  };

  const resetTimer = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      resolveSeq(seq, { status: "timeout" });
      shutdown(4);
    }, args.timeoutMs);
  };

  let server: ReturnType<typeof Bun.serve>;
  const shutdown = (code: number) => {
    if (timer) clearTimeout(timer);
    setTimeout(async () => {
      await clearState("clarity", process.pid);
      await server.stop();
      process.exit(code);
    }, 50);
  };

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(inject(boot()), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }
      if (req.method === "GET" && url.pathname === "/api/bootstrap") {
        return json(boot());
      }

      if (req.method === "POST" && url.pathname === "/api/result") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (body.token !== token) return json({ error: "bad token" }, 403);
        const wanted = typeof body.seq === "number" ? body.seq : 0;
        if (!wanted) return json({ error: "missing seq" }, 422);
        return json(await waitSeq(wanted));
      }

      if (req.method === "POST" && url.pathname === "/api/continue") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (body.token !== token) return json({ error: "bad token" }, 403);
        try {
          payload = validatePayload(body.payload);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return json({ error: msg }, 422);
        }
        if (!payload.flow) return json({ error: "continue payload requires flow" }, 422);
        seq += 1;
        resetTimer();
        return json({ ok: true, seq });
      }

      if (req.method === "POST" && url.pathname === "/api/submit") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (body.token !== token) return json({ error: "bad token" }, 403);
        const verdict = buildClaritySubmission(payload, body);
        if (!verdict.ok) return json({ error: verdict.error }, 422);
        resolveSeq(seq, { status: "submitted", result: verdict.result });
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/cancel") {
        const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
        if (body.token !== token) return json({ error: "bad token" }, 403);
        resolveSeq(seq, { status: "cancelled" });
        shutdown(0);
        return json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });

  resetTimer();
  const url = `http://127.0.0.1:${server.port}/`;
  await writeState({ mode: "clarity", url, token, pid: process.pid, startedAt: new Date().toISOString() });
  process.stderr.write(`clarinator: review at ${url}\n`);
  if (args.open) openBrowser(url);
  await new Promise(() => undefined);
  process.exit(0);
}

async function runUp(args: Args): Promise<never> {
  const token = crypto.randomUUID();
  let prepared: { boot: Bootstrap; onSubmit: OnSubmit };
  if (args.mode === "clarity") {
    const payload = await readClarityPayload(args.input);
    if (payload.flow) await runFlowUp(args, payload);
    prepared = prepareClarity(payload, token, args.locale);
  } else {
    prepared = await prepare(args, token);
  }
  const { boot, onSubmit } = prepared;
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
  if (args.action === "continue") await runContinue(args);
  if (args.action === "serve-flow") await runServeFlow(args);
  await runUp(args);
}

main();
