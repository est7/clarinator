import type { Answer, ClarityDecision } from "../types.ts";
import type { Strings } from "../i18n.ts";

export function Decision({
  decision,
  index,
  isChild,
  value,
  onChange,
  t,
}: {
  decision: ClarityDecision;
  index: number;
  isChild: boolean;
  value: Answer | undefined;
  onChange: (value: Answer) => void;
  t: Strings;
}) {
  const selectedOption = value?.kind === "option" ? value.optionId : undefined;
  const customSelected = value?.kind === "custom";
  const groupName = `dec-${decision.id}`;

  return (
    <section className={isChild ? "decision child" : "decision"}>
      <div className="qrow">
        <span className="idx">{String(index + 1).padStart(2, "0")}</span>
        <p className="q">{decision.question}</p>
      </div>
      <p className="why">
        <b>{t.whyDefault}</b> {decision.recommendation_reason}
      </p>

      {decision.options.map((opt) => {
        const sel = selectedOption === opt.id;
        return (
          <label key={opt.id} className={sel ? "opt sel" : "opt"}>
            <input
              type="radio"
              name={groupName}
              checked={sel}
              onChange={() => onChange({ kind: "option", optionId: opt.id })}
            />
            <span className="body">
              <span className="label">
                {opt.label}
                {opt.recommended && <span className="badge-rec">{t.recommended}</span>}
              </span>
              {opt.description && <span className="desc">{opt.description}</span>}
              {opt.reason && <span className="rsn">{opt.reason}</span>}
            </span>
          </label>
        );
      })}

      {decision.allow_custom && (
        <label className={customSelected ? "opt sel" : "opt"}>
          <input
            type="radio"
            name={groupName}
            checked={customSelected}
            onChange={() => onChange({ kind: "custom", value: customSelected ? (value as { value: string }).value : "" })}
          />
          <span className="body">
            <span className="label">{t.somethingElse}</span>
            <span className="custom">
              <textarea
                placeholder={t.customPlaceholder}
                value={customSelected ? (value as { value: string }).value : ""}
                onFocus={() => {
                  if (!customSelected) onChange({ kind: "custom", value: "" });
                }}
                onChange={(e) => onChange({ kind: "custom", value: e.target.value })}
              />
            </span>
          </span>
        </label>
      )}
    </section>
  );
}
