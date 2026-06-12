// Bun-runtime tests (Bun.serve / Bun.spawn are unavailable under vitest/node).
// Run with `bun test tests/`. Pure-logic tests live in src/**.test.ts (vitest).
import { test, expect } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startBlockingSingleSubmitServer } from "../server/primitive.ts";

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const root = new URL("..", import.meta.url).pathname;

async function writePayload(payload: unknown): Promise<{ stateDir: string; payloadPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), "clarinator-test-"));
  const payloadPath = join(dir, "payload.json");
  await writeFile(payloadPath, JSON.stringify(payload), "utf8");
  return { stateDir: join(dir, "state"), payloadPath };
}

async function readReviewUrl(proc: ReturnType<typeof Bun.spawn>): Promise<string> {
  const reader = proc.stderr.getReader();
  const dec = new TextDecoder();
  let errText = "";
  let url: string | undefined;
  while (!url) {
    const { value, done } = await reader.read();
    if (done) break;
    errText += dec.decode(value);
    url = errText.match(/review at (http:\/\/127\.0\.0\.1:\d+\/)/)?.[1];
  }
  reader.releaseLock();
  expect(url).toBeTruthy();
  return url!;
}

async function bootstrapToken(url: string): Promise<string> {
  const html = await (await fetch(url)).text();
  expect(html).toContain("<script>window.__CLARINATOR__");
  const token = html.match(/"token":"([0-9a-f-]+)"/)?.[1];
  expect(token).toBeTruthy();
  return token!;
}

async function waitForBootstrapPage(url: string, pageId: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const res = await fetch(url + "api/bootstrap");
    if (res.ok) {
      const boot = await res.json();
      if (boot?.payload?.flow?.page_id === pageId) return;
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for page ${pageId}`);
}

test("submit resolves with the onSubmit result", async () => {
  const srv = startBlockingSingleSubmitServer({
    html: "<html></html>",
    token: "tok",
    timeoutMs: 5000,
    onSubmit: (body) => ({ ok: true, result: { echoed: (body as { answers: unknown }).answers } }),
  });
  const res = await post(srv.url + "api/submit", { token: "tok", answers: { a: 1 } });
  expect(res.status).toBe(200);
  const outcome = await srv.done;
  srv.stop();
  expect(outcome).toEqual({ status: "submitted", result: { echoed: { a: 1 } } });
});

test("bad token is rejected and does not resolve", async () => {
  const srv = startBlockingSingleSubmitServer({
    html: "<html></html>",
    token: "tok",
    timeoutMs: 5000,
    onSubmit: () => ({ ok: true, result: 1 }),
  });
  const res = await post(srv.url + "api/submit", { token: "WRONG", answers: {} });
  expect(res.status).toBe(403);
  // Still blocking → cancel to clean up.
  await post(srv.url + "api/cancel", { token: "tok" });
  expect((await srv.done).status).toBe("cancelled");
  srv.stop();
});

test("onSubmit rejection returns 422 and keeps blocking", async () => {
  const srv = startBlockingSingleSubmitServer({
    html: "<html></html>",
    token: "tok",
    timeoutMs: 5000,
    onSubmit: () => ({ ok: false, error: "nope" }),
  });
  const res = await post(srv.url + "api/submit", { token: "tok", answers: {} });
  expect(res.status).toBe(422);
  srv.stop();
});

test("timeout resolves with timeout", async () => {
  const srv = startBlockingSingleSubmitServer({
    html: "<html></html>",
    token: "tok",
    timeoutMs: 40,
    onSubmit: () => ({ ok: true, result: 1 }),
  });
  expect((await srv.done).status).toBe("timeout");
  srv.stop();
});

test("onSubmit throwing fails fast with an error outcome (no hang to timeout)", async () => {
  const srv = startBlockingSingleSubmitServer({
    html: "<html></html>",
    token: "tok",
    timeoutMs: 60000, // long: if the throw were swallowed, the test would hang
    onSubmit: () => {
      throw new Error("boom");
    },
  });
  const res = await post(srv.url + "api/submit", { token: "tok", answers: {} });
  expect(res.status).toBe(500);
  const outcome = await srv.done;
  expect(outcome).toEqual({ status: "error", error: "boom" });
  srv.stop();
});

test("bin clarity up: validate → serve → submit → stdout + exit 0", async () => {
  const payload = {
    title: "Login PRD",
    context: "context",
    decisions: [
      {
        id: "auth-method",
        question: "Which auth methods?",
        recommendation_reason: "reason long enough to pass",
        options: [
          { id: "magic-link", label: "Magic link", recommended: true },
          { id: "password", label: "Password", recommended: false },
        ],
      },
    ],
  };

  const { stateDir, payloadPath } = await writePayload(payload);
  const proc = Bun.spawn(["bun", "bin/clarinator.ts", "clarity", "up", "--input", payloadPath, "--no-open", "--timeout-ms", "10000"], {
    cwd: root,
    env: { ...process.env, CLARINATOR_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = await readReviewUrl(proc);
  const token = await bootstrapToken(url);

  const res = await post(url + "api/submit", {
    token,
    answers: { "auth-method": { kind: "option", optionId: "magic-link" } },
  });
  expect(res.status).toBe(200);

  const out = JSON.parse(await Bun.readableStreamToText(proc.stdout));
  expect(await proc.exited).toBe(0);
  expect(out.mode).toBe("clarity");
  expect(out.action).toBe("done");
  expect(out.result).toEqual([
    { decisionId: "auth-method", question: "Which auth methods?", optionId: "magic-link", answer: "Magic link", custom: false },
  ]);
});

test("bin clarity flow: continue returns page result for the agent to generate the next payload", async () => {
  const payload = {
    title: "Login PRD",
    context: "Pick the first page scope.",
    flow: {
      session_id: "login-prd",
      page_id: "scope",
      page_title: "Page 1: Scope",
      continue_label: "Next page",
      done_label: "Done",
    },
    decisions: [
      {
        id: "auth-method",
        question: "Which auth methods?",
        recommendation_reason: "reason long enough to pass",
        options: [
          { id: "magic-link", label: "Magic link", recommended: true },
          { id: "password", label: "Password", recommended: false },
        ],
      },
    ],
  };

  const { stateDir, payloadPath } = await writePayload(payload);
  const proc = Bun.spawn(["bun", "bin/clarinator.ts", "clarity", "up", "--input", payloadPath, "--no-open", "--timeout-ms", "10000"], {
    cwd: root,
    env: { ...process.env, CLARINATOR_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = await readReviewUrl(proc);
  const token = await bootstrapToken(url);

  const res = await post(url + "api/submit", {
    token,
    action: "continue",
    answers: { "auth-method": { kind: "option", optionId: "password" } },
  });
  expect(res.status).toBe(200);

  const out = JSON.parse(await Bun.readableStreamToText(proc.stdout));
  expect(await proc.exited).toBe(0);
  expect(out).toMatchObject({
    mode: "clarity",
    title: "Login PRD",
    action: "continue",
    sessionId: "login-prd",
    pageId: "scope",
    result: [{ decisionId: "auth-method", optionId: "password", answer: "Password", custom: false }],
  });
  const down = Bun.spawn(["bun", "bin/clarinator.ts", "clarity", "down"], {
    cwd: root,
    env: { ...process.env, CLARINATOR_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await down.exited).toBe(0);
});

test("bin clarity flow examples: page1 up, page2 continue, then down", async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), "clarinator-flow-e2e-")), "state");
  const env = { ...process.env, CLARINATOR_STATE_DIR: stateDir };

  const up = Bun.spawn([
    "bun",
    "bin/clarinator.ts",
    "clarity",
    "up",
    "--input",
    join(root, "examples", "clarity-flow-page1.json"),
    "--no-open",
    "--timeout-ms",
    "10000",
  ], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = await readReviewUrl(up);
  const token = await bootstrapToken(url);
  const firstSubmit = await post(url + "api/submit", {
    token,
    action: "continue",
    answers: { "auth-method": { kind: "option", optionId: "password" } },
  });
  expect(firstSubmit.status).toBe(200);

  const page1 = JSON.parse(await Bun.readableStreamToText(up.stdout));
  expect(await up.exited).toBe(0);
  expect(page1).toMatchObject({
    mode: "clarity",
    action: "continue",
    sessionId: "login-prd",
    pageId: "entry-path",
    result: [{ decisionId: "auth-method", optionId: "password", answer: "Password plus magic link", custom: false }],
  });

  const cont = Bun.spawn([
    "bun",
    "bin/clarinator.ts",
    "clarity",
    "continue",
    "--input",
    join(root, "examples", "clarity-flow-page2-password.json"),
    "--timeout-ms",
    "10000",
  ], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  await waitForBootstrapPage(url, "password-details");
  const secondSubmit = await post(url + "api/submit", {
    token,
    action: "done",
    answers: {
      "password-strength": { kind: "option", optionId: "lenient" },
      "recovery-flow": { kind: "option", optionId: "magic-link-reset" },
    },
  });
  expect(secondSubmit.status).toBe(200);

  const page2 = JSON.parse(await Bun.readableStreamToText(cont.stdout));
  expect(await cont.exited).toBe(0);
  expect(page2).toMatchObject({
    mode: "clarity",
    action: "done",
    sessionId: "login-prd",
    pageId: "password-details",
    result: [
      { decisionId: "password-strength", optionId: "lenient", answer: "8+ characters, no composition rules", custom: false },
      { decisionId: "recovery-flow", optionId: "magic-link-reset", answer: "Use magic link as reset", custom: false },
    ],
  });

  const down = Bun.spawn(["bun", "bin/clarinator.ts", "clarity", "down"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(await down.exited).toBe(0);
});

test("bin clarity flow rejects done when the page requires continue", async () => {
  const stateDir = join(await mkdtemp(join(tmpdir(), "clarinator-flow-e2e-")), "state");
  const proc = Bun.spawn([
    "bun",
    "bin/clarinator.ts",
    "clarity",
    "up",
    "--input",
    join(root, "examples", "clarity-flow-page1.json"),
    "--no-open",
    "--timeout-ms",
    "10000",
  ], {
    cwd: root,
    env: { ...process.env, CLARINATOR_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = await readReviewUrl(proc);
  const token = await bootstrapToken(url);
  const res = await post(url + "api/submit", {
    token,
    action: "done",
    answers: { "auth-method": { kind: "option", optionId: "password" } },
  });
  expect(res.status).toBe(422);

  await post(url + "api/cancel", { token });
  expect(await proc.exited).toBe(3);
});

test("bin plan up: validate → serve → annotate + revise → stdout", async () => {
  const payload = { title: "Plan", plan: "## Goal\n\nShip it.\n\n## Risks\n\nToken replay." };

  const { stateDir, payloadPath } = await writePayload(payload);
  const proc = Bun.spawn(["bun", "bin/clarinator.ts", "plan", "up", "--input", payloadPath, "--no-open", "--timeout-ms", "10000"], {
    cwd: root,
    env: { ...process.env, CLARINATOR_STATE_DIR: stateDir },
    stdout: "pipe",
    stderr: "pipe",
  });

  const url = await readReviewUrl(proc);
  const token = await bootstrapToken(url);

  const res = await post(url + "api/submit", {
    token,
    decision: "revise",
    annotations: [{ blockIndex: 1, quote: "## Risks", comment: "also rate-limit /auth/request" }],
    generalFeedback: "tighten the token TTL",
  });
  expect(res.status).toBe(200);

  const out = JSON.parse(await Bun.readableStreamToText(proc.stdout));
  expect(await proc.exited).toBe(0);
  expect(out.mode).toBe("plan");
  expect(out.decision).toBe("revise");
  expect(out.annotations).toEqual([{ blockIndex: 1, quote: "## Risks", comment: "also rate-limit /auth/request" }]);
  expect(out.generalFeedback).toBe("tighten the token TTL");
});

test("bin down cancels the active mode session through saved state", async () => {
  const payload = {
    title: "Login PRD",
    context: "context",
    decisions: [
      {
        id: "auth-method",
        question: "Which auth methods?",
        recommendation_reason: "reason long enough to pass",
        options: [
          { id: "magic-link", label: "Magic link", recommended: true },
          { id: "password", label: "Password", recommended: false },
        ],
      },
    ],
  };
  const { stateDir, payloadPath } = await writePayload(payload);
  const env = { ...process.env, CLARINATOR_STATE_DIR: stateDir };
  const up = Bun.spawn(["bun", "bin/clarinator.ts", "clarity", "up", "--input", payloadPath, "--no-open", "--timeout-ms", "10000"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  await readReviewUrl(up);
  const down = Bun.spawn(["bun", "bin/clarinator.ts", "clarity", "down"], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await down.exited).toBe(0);
  expect(await up.exited).toBe(3);
  expect(JSON.parse(await Bun.readableStreamToText(up.stdout))).toEqual({ status: "cancelled" });
  expect(await Bun.file(join(stateDir, "clarity.json")).exists()).toBe(false);
});

test("bin rejects removed --mode entrypoint", async () => {
  const proc = Bun.spawn(["bun", "bin/clarinator.ts", "--mode", "clarity"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await proc.exited).toBe(2);
  expect(await Bun.readableStreamToText(proc.stderr)).toContain("usage: clarinator [--version] <clarity|plan> <up|continue|down>");
});

test("bin --version prints package version", async () => {
  const packageJson = await Bun.file(join(root, "package.json")).json() as { version: string };
  const proc = Bun.spawn(["bun", "bin/clarinator.ts", "--version"], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });

  expect(await proc.exited).toBe(0);
  expect(await Bun.readableStreamToText(proc.stdout)).toBe(`${packageJson.version}\n`);
  expect(await Bun.readableStreamToText(proc.stderr)).toBe("");
});
