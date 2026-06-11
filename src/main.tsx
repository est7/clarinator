import { StrictMode, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import type { Answer, Answers, Bootstrap } from "./types.ts";
import { activeDecisions, answer as applyAnswer, isComplete, missing } from "./reducer.ts";
import { resolveLocale, strings } from "./i18n.ts";
import { Decision } from "./components/Decision.tsx";

type Phase = "answering" | "sent" | "cancelled" | "error";

function App({ boot }: { boot: Bootstrap }) {
  const { payload, token } = boot;
  const t = useMemo(() => strings(resolveLocale(boot.locale)), [boot.locale]);
  const [answers, setAnswers] = useState<Answers>({});
  const [phase, setPhase] = useState<Phase>("answering");
  const [busy, setBusy] = useState(false);

  const visible = useMemo(() => activeDecisions(payload, answers), [payload, answers]);
  const complete = isComplete(payload, answers);
  const answeredCount = visible.length - missing(payload, answers).length;

  function onChange(decisionId: string, value: Answer) {
    setAnswers((prev) => applyAnswer(payload, prev, decisionId, value));
  }

  async function post(path: string, body: unknown) {
    setBusy(true);
    try {
      const res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setPhase("error");
        return;
      }
      return true;
    } catch {
      setPhase("error");
    } finally {
      setBusy(false);
    }
  }

  async function submit() {
    if (!complete) return;
    if (await post("/api/submit", { token, answers })) setPhase("sent");
  }

  async function cancel() {
    if (await post("/api/cancel", { token })) setPhase("cancelled");
  }

  if (phase === "sent") {
    return (
      <div className="end">
        <div className="mark">✓</div>
        <h2>{t.sentTitle}</h2>
        <p>{t.sentBody}</p>
      </div>
    );
  }
  if (phase === "cancelled") {
    return (
      <div className="end">
        <div className="mark">⊘</div>
        <h2>{t.cancelledTitle}</h2>
        <p>{t.cancelledBody}</p>
      </div>
    );
  }
  if (phase === "error") {
    return (
      <div className="end err">
        <div className="mark">✕</div>
        <h2>{t.errorTitle}</h2>
        <p>{t.errorBody}</p>
      </div>
    );
  }

  // Compute display index per decision (stable across reveals → use payload order).
  const orderIndex = new Map(payload.decisions.map((d, i) => [d.id, i]));

  return (
    <div className="wrap">
      <header className="masthead">
        <h1>{payload.title}</h1>
        {payload.subtitle && <div className="sub">{payload.subtitle}</div>}
        <div className="context">{payload.context}</div>
      </header>

      {visible.map((dec) => (
        <Decision
          key={dec.id}
          decision={dec}
          index={orderIndex.get(dec.id) ?? 0}
          isChild={dec.show_if !== undefined}
          value={answers[dec.id]}
          onChange={(v) => onChange(dec.id, v)}
          t={t}
        />
      ))}

      <div className="bar">
        <div className="inner">
          <span className="count">{t.answered(answeredCount, visible.length)}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={cancel} disabled={busy}>
            {t.cancel}
          </button>
          <button className="btn primary" onClick={submit} disabled={!complete || busy}>
            {t.send}
          </button>
        </div>
      </div>
    </div>
  );
}

const boot = window.__CLARINATOR__;
const rootEl = document.getElementById("root")!;
if (!boot) {
  const tf = strings(resolveLocale());
  rootEl.innerHTML = `<div class="end err"><div class="mark">✕</div><h2>${tf.noPayloadTitle}</h2><p>${tf.noPayloadBody}</p></div>`;
} else {
  createRoot(rootEl).render(
    <StrictMode>
      <App boot={boot} />
    </StrictMode>,
  );
}
