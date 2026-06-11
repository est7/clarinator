#!/usr/bin/env bun
// clarinator CLI. Foreground, blocking: validate the payload, serve the committed
// single-file UI on loopback, block until the user submits/cancels (or it times
// out), print the structured result to stdout, exit. The agent reads stdout.
//
//   clarinator --mode clarity --input payload.json [--out answers.json]
//              [--timeout-ms 1800000] [--locale zh] [--no-open]
//
// Exit codes: 0 submitted · 2 usage/validation error · 3 cancelled · 4 timeout.

import { validatePayload, validatePlanPayload, ValidationError } from "../src/validate.ts";
import { buildResult, validateAnswers } from "../src/reducer.ts";
import { injectBootstrap } from "../src/bootstrapHtml.ts";
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

interface Args {
  mode: string;
  input?: string;
  out?: string;
  timeoutMs: number;
  locale?: string;
  open: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { mode: "clarity", timeoutMs: 30 * 60 * 1000, open: true };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) fail(`missing value for ${k}`);
      return v as string;
    };
    switch (k) {
      case "--mode": a.mode = next(); break;
      case "--input": a.input = next(); break;
      case "--out": a.out = next(); break;
      case "--timeout-ms": a.timeoutMs = Number(next()); break;
      case "--locale": a.locale = next(); break;
      case "--no-open": a.open = false; break;
      default: fail(`unknown argument: ${k}`);
    }
  }
  if (!Number.isFinite(a.timeoutMs) || a.timeoutMs <= 0) fail("--timeout-ms must be a positive number");
  return a;
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
    return injectBootstrap(appHtml, boot);
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
      const answers = sanitizeAnswers(payload, (body as Record<string, unknown>).answers);
      const verdict = validateAnswers(payload, answers);
      if (!verdict.ok) return verdict;
      return { ok: true, result: { mode: "clarity", title: payload.title, result: buildResult(payload, answers) } };
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
  return fail(`unknown mode ${JSON.stringify(args.mode)} (expected "clarity" or "plan")`);
}

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  const token = crypto.randomUUID();
  const { boot, onSubmit } = await prepare(args, token);
  const html = inject(boot);

  const server = startBlockingSingleSubmitServer<Submission>({ html, token, timeoutMs: args.timeoutMs, onSubmit });

  process.stderr.write(`clarinator: review at ${server.url}\n`);
  if (args.open) openBrowser(server.url);

  const outcome = await server.done;
  // Graceful stop drains the in-flight submit/cancel ACK before closing, so the
  // browser reliably shows its end screen. The small sleep only lets the browser
  // paint that screen; correctness comes from the graceful drain, not the timing.
  await Bun.sleep(150);
  await server.stop();

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

main();
