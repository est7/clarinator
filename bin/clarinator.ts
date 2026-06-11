#!/usr/bin/env bun
// clarinator CLI. Foreground, blocking: validate the payload, serve the committed
// single-file UI on loopback, block until the user submits/cancels (or it times
// out), print the structured result to stdout, exit. The agent reads stdout.
//
//   clarinator --mode clarity --input payload.json [--out answers.json]
//              [--timeout-ms 1800000] [--locale zh] [--no-open]
//
// Exit codes: 0 submitted · 2 usage/validation error · 3 cancelled · 4 timeout.

import { validatePayload, ValidationError } from "../src/validate.ts";
import { buildResult, isComplete } from "../src/reducer.ts";
import type { Answer, Answers, Bootstrap, ClarityPayload, ClaritySubmission } from "../src/types.ts";
import { startBlockingSingleSubmitServer } from "../server/primitive.ts";

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

async function loadHtml(): Promise<string> {
  // Resolve relative to THIS module (not cwd) so it works from the installed
  // package dir under bunx. Built by `vite build` and committed.
  const file = Bun.file(new URL("../dist/clarity.html", import.meta.url));
  if (!(await file.exists())) {
    fail("dist/clarity.html not found — run `bun run build` (or the published package is incomplete)");
  }
  return file.text();
}

function inject(html: string, boot: Bootstrap): string {
  const safe = JSON.stringify(boot).replace(/</g, "\\u003c");
  const tag = `<script>window.__CLARINATOR__ = ${safe};</script>`;
  if (!html.includes("</head>")) fail("dist/clarity.html missing </head> sentinel");
  return html.replace("</head>", `${tag}</head>`);
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

async function main() {
  const args = parseArgs(Bun.argv.slice(2));
  if (args.mode !== "clarity") fail(`mode ${JSON.stringify(args.mode)} not implemented yet (only "clarity")`);

  let payload: ClarityPayload;
  try {
    payload = validatePayload(await readInput(args.input));
  } catch (e) {
    if (e instanceof ValidationError) fail(`payload validation failed: ${e.message}`);
    throw e;
  }

  const token = crypto.randomUUID();
  const boot: Bootstrap = { mode: "clarity", token, locale: args.locale, payload };
  const html = inject(await loadHtml(), boot);

  const server = startBlockingSingleSubmitServer<ClaritySubmission>({
    html,
    token,
    timeoutMs: args.timeoutMs,
    onSubmit: (body) => {
      const answers = sanitizeAnswers(payload, (body as Record<string, unknown>).answers);
      if (!isComplete(payload, answers)) return { ok: false, error: "not all active decisions answered" };
      return {
        ok: true,
        result: { mode: "clarity", title: payload.title, result: buildResult(payload, answers) },
      };
    },
  });

  process.stderr.write(`clarinator: review at ${server.url}\n`);
  if (args.open) openBrowser(server.url);

  const outcome = await server.done;
  // Let the HTTP ack flush to the browser (so it shows the end screen) before we
  // tear down the listener — otherwise stop() races the response into ECONNRESET.
  await Bun.sleep(400);
  server.stop();

  if (outcome.status === "submitted") {
    const text = JSON.stringify(outcome.result, null, 2);
    if (args.out) await Bun.write(args.out, text);
    process.stdout.write(text + "\n");
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ status: outcome.status }) + "\n");
  process.exit(outcome.status === "cancelled" ? 3 : 4);
}

main();
