import type { Strings } from "../i18n.ts";

/** Terminal screen shown after submit / cancel / connection loss. */
export function EndScreen({ phase, t }: { phase: "handoff" | "sent" | "cancelled" | "error"; t: Strings }) {
  if (phase === "handoff") {
    return (
      <div className="end">
        <div className="mark">✓</div>
        <h2>{t.handoffTitle}</h2>
        <p>{t.handoffBody}</p>
      </div>
    );
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
  return (
    <div className="end err">
      <div className="mark">✕</div>
      <h2>{t.errorTitle}</h2>
      <p>{t.errorBody}</p>
    </div>
  );
}
