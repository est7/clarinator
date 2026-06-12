import { useEffect, useMemo, useState } from "react";
import type { Answer, Answers, ClarityBootstrap, ClarityPayload } from "../types.ts";
import { activeDecisions, answer as applyAnswer, isComplete, missing } from "../reducer.ts";
import { resolveLocale, strings } from "../i18n.ts";
import { useReview } from "../useReview.ts";
import { Decision } from "../components/Decision.tsx";
import { EndScreen } from "../components/EndScreen.tsx";

export function ClarityApp({ boot }: { boot: ClarityBootstrap }) {
  const [payload, setPayload] = useState<ClarityPayload>(boot.payload);
  const flow = payload.flow;
  const t = useMemo(() => strings(resolveLocale(boot.locale)), [boot.locale]);
  const [answers, setAnswers] = useState<Answers>({});
  const { phase, busy, submit, cancel, resume } = useReview(boot.token);

  const visible = useMemo(() => activeDecisions(payload, answers), [payload, answers]);
  const complete = isComplete(payload, answers);
  const answeredCount = visible.length - missing(payload, answers).length;
  const doneLabel = flow?.done_label ?? (flow ? t.done : t.send);

  function onChange(decisionId: string, value: Answer) {
    setAnswers((prev) => applyAnswer(payload, prev, decisionId, value));
  }

  useEffect(() => {
    if (phase !== "handoff") return;
    let alive = true;
    const currentPage = payload.flow?.page_id ?? "";
    const poll = async () => {
      try {
        const res = await fetch("/api/bootstrap", { cache: "no-store" });
        if (!res.ok) return;
        const next = (await res.json()) as ClarityBootstrap;
        if (!alive || next.mode !== "clarity") return;
        const nextPage = next.payload.flow?.page_id ?? "";
        if (nextPage && nextPage !== currentPage) {
          setPayload(next.payload);
          setAnswers({});
          resume();
        }
      } catch {
        // The end screen already tells the user to return to the terminal if the
        // local server disappears.
      }
    };
    const id = setInterval(poll, 1000);
    poll();
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [phase, payload.flow?.page_id]);

  if (phase !== "active") return <EndScreen phase={phase} t={t} />;

  const orderIndex = new Map(payload.decisions.map((d, i) => [d.id, i]));

  return (
    <div className="wrap clarity-wrap">
      <header className="masthead">
        <h1>{payload.title}</h1>
        {payload.subtitle && <div className="sub">{payload.subtitle}</div>}
        {flow?.page_title && <div className="sub">{flow.page_title}</div>}
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
          {flow ? (
            <button className="btn primary" onClick={() => submit({ answers, action: "continue" }, "handoff")} disabled={!complete || busy}>
              {t.send}
            </button>
          ) : (
            <button className="btn primary" onClick={() => submit({ answers, action: "done" })} disabled={!complete || busy}>
              {doneLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
