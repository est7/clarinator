// The blocking primitive, deliberately domain-free (codex round-1 #7): serve one
// HTML page on loopback, block until exactly one authenticated submit/cancel or a
// timeout, then resolve. No clarity/plan concepts here — the caller supplies the
// HTML and an `onSubmit` that validates the body into a result. Reused by Step 2.

export type SubmitOutcome<R> =
  | { status: "submitted"; result: R }
  | { status: "cancelled" }
  | { status: "timeout" };

export interface BlockingServerOptions<R> {
  html: string;
  /** Shared secret echoed in the page; submit/cancel must present it. */
  token: string;
  timeoutMs: number;
  hostname?: string;
  /** Validate a submit body into a result, or reject with a message. */
  onSubmit: (body: unknown) => { ok: true; result: R } | { ok: false; error: string };
}

export interface BlockingServer<R> {
  url: string;
  port: number;
  done: Promise<SubmitOutcome<R>>;
  stop: () => void;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export function startBlockingSingleSubmitServer<R>(opts: BlockingServerOptions<R>): BlockingServer<R> {
  const hostname = opts.hostname ?? "127.0.0.1";
  let resolveDone!: (o: SubmitOutcome<R>) => void;
  const done = new Promise<SubmitOutcome<R>>((r) => (resolveDone = r));
  let settled = false;

  const finish = (o: SubmitOutcome<R>) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveDone(o);
  };

  const timer = setTimeout(() => finish({ status: "timeout" }), opts.timeoutMs);

  async function readToken(req: Request): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    try {
      const body = (await req.json()) as Record<string, unknown>;
      return { ok: body?.token === opts.token, body };
    } catch {
      return { ok: false, body: {} };
    }
  }

  const server = Bun.serve({
    hostname,
    port: 0, // OS-assigned free port
    async fetch(req) {
      const url = new URL(req.url);

      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        return new Response(opts.html, {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });
      }

      if (req.method === "POST" && url.pathname === "/api/submit") {
        const { ok, body } = await readToken(req);
        if (!ok) return json({ error: "bad token" }, 403);
        const verdict = opts.onSubmit(body);
        if (!verdict.ok) return json({ error: verdict.error }, 422);
        finish({ status: "submitted", result: verdict.result });
        return json({ ok: true });
      }

      if (req.method === "POST" && url.pathname === "/api/cancel") {
        const { ok } = await readToken(req);
        if (!ok) return json({ error: "bad token" }, 403);
        finish({ status: "cancelled" });
        return json({ ok: true });
      }

      return new Response("not found", { status: 404 });
    },
  });

  const port = server.port ?? 0;
  return {
    url: `http://${hostname}:${port}/`,
    port,
    done,
    stop: () => {
      clearTimeout(timer);
      server.stop(true);
    },
  };
}
