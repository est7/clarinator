// Bun-runtime tests (Bun.serve / Bun.spawn are unavailable under vitest/node).
// Run with `bun test tests/`. Pure-logic tests live in src/**.test.ts (vitest).
import { test, expect } from "bun:test";
import { startBlockingSingleSubmitServer } from "../server/primitive.ts";

const post = (url: string, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

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

test("bin end-to-end: validate → serve → submit → stdout + exit 0", async () => {
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

  const proc = Bun.spawn(["bun", "bin/clarinator.ts", "--mode", "clarity", "--no-open", "--timeout-ms", "10000"], {
    cwd: new URL("..", import.meta.url).pathname,
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stderr incrementally until the URL appears (the process keeps running,
  // so draining to EOF would hang).
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

  // Pull the token out of the injected bootstrap.
  const html = await (await fetch(url!)).text();
  const token = html.match(/"token":"([0-9a-f-]+)"/)?.[1];
  expect(token).toBeTruthy();

  const res = await post(url! + "api/submit", {
    token,
    answers: { "auth-method": { kind: "option", optionId: "magic-link" } },
  });
  expect(res.status).toBe(200);

  const out = JSON.parse(await Bun.readableStreamToText(proc.stdout));
  expect(await proc.exited).toBe(0);
  expect(out.mode).toBe("clarity");
  expect(out.result).toEqual([
    { decisionId: "auth-method", question: "Which auth methods?", optionId: "magic-link", answer: "Magic link", custom: false },
  ]);
});
