import { useMemo, useState } from "react";
import type { Answer, Answers, ClarityBootstrap } from "../types.ts";
import { activeDecisions, answer as applyAnswer, isComplete, missing } from "../reducer.ts";
import { resolveLocale, strings } from "../i18n.ts";
import { useReview } from "../useReview.ts";
import { Decision } from "../components/Decision.tsx";
import { EndScreen } from "../components/EndScreen.tsx";

export function ClarityApp({ boot }: { boot: ClarityBootstrap }) {
  const { payload } = boot;
  const t = useMemo(() => strings(resolveLocale(boot.locale)), [boot.locale]);
  const [answers, setAnswers] = useState<Answers>({});
  const { phase, busy, submit, cancel } = useReview(boot.token);

  const visible = useMemo(() => activeDecisions(payload, answers), [payload, answers]);
  const complete = isComplete(payload, answers);
  const answeredCount = visible.length - missing(payload, answers).length;

  function onChange(decisionId: string, value: Answer) {
    setAnswers((prev) => applyAnswer(payload, prev, decisionId, value));
  }

  if (phase !== "active") return <EndScreen phase={phase} t={t} />;

  const orderIndex = new Map(payload.decisions.map((d, i) => [d.id, i]));

  return (
    <div className="wrap clarity-wrap">
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
          <button className="btn primary" onClick={() => submit({ answers })} disabled={!complete || busy}>
            {t.send}
          </button>
        </div>
      </div>
    </div>
  );
}
