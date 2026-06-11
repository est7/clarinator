import { useEffect, useState } from "react";

export type Phase = "active" | "sent" | "cancelled" | "error";

/**
 * Shared submit/cancel plumbing for both modes: POSTs to the blocking server,
 * tracks the end phase, and best-effort auto-closes the tab once done (browsers
 * only honor close for script-opened tabs, so the end screen stays as fallback).
 */
export function useReview(token: string) {
  const [phase, setPhase] = useState<Phase>("active");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (phase !== "sent" && phase !== "cancelled") return;
    const id = setTimeout(() => {
      try {
        window.close();
      } catch {
        /* blocked by the browser */
      }
    }, 700);
    return () => clearTimeout(id);
  }, [phase]);

  async function post(path: string, body: unknown): Promise<boolean> {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setPhase("error");
        return false;
      }
      return true;
    } catch {
      setPhase("error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function submit(body: Record<string, unknown>): Promise<void> {
    if (await post("/api/submit", { token, ...body })) setPhase("sent");
  }

  async function cancel(): Promise<void> {
    if (await post("/api/cancel", { token })) setPhase("cancelled");
  }

  return { phase, busy, submit, cancel };
}
