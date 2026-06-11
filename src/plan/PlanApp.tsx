import { useMemo, useState } from "react";
import { marked } from "marked";
import type { PlanAnnotation, PlanBootstrap } from "../types.ts";
import { resolveLocale, strings } from "../i18n.ts";
import { useReview } from "../useReview.ts";
import { EndScreen } from "../components/EndScreen.tsx";

interface Block {
  html: string;
  quote: string;
}

/** Split the plan markdown into top-level blocks; each is independently commentable. */
function planBlocks(md: string): Block[] {
  const tokens = marked.lexer(md);
  const blocks: Block[] = [];
  for (const tok of tokens) {
    if (tok.type === "space") continue;
    const raw = ("raw" in tok ? tok.raw : "") || "";
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) continue;
    blocks.push({ html: marked.parser([tok]), quote: text.slice(0, 100) });
  }
  return blocks;
}

export function PlanApp({ boot }: { boot: PlanBootstrap }) {
  const { payload } = boot;
  const t = useMemo(() => strings(resolveLocale(boot.locale)), [boot.locale]);
  const blocks = useMemo(() => planBlocks(payload.plan), [payload.plan]);
  // blockIndex -> comment text ("" means the editor is open but empty).
  const [comments, setComments] = useState<Record<number, string>>({});
  const [general, setGeneral] = useState("");
  const { phase, busy, submit, cancel } = useReview(boot.token);

  const annotations: PlanAnnotation[] = Object.entries(comments)
    .map(([i, c]) => ({ blockIndex: Number(i), quote: blocks[Number(i)]?.quote ?? "", comment: c.trim() }))
    .filter((a) => a.comment.length > 0)
    .sort((a, b) => a.blockIndex - b.blockIndex);

  function openComment(i: number) {
    setComments((prev) => (i in prev ? prev : { ...prev, [i]: "" }));
  }
  function setComment(i: number, text: string) {
    setComments((prev) => ({ ...prev, [i]: text }));
  }
  function removeComment(i: number) {
    setComments((prev) => {
      const next = { ...prev };
      delete next[i];
      return next;
    });
  }

  function send(decision: "approve" | "revise") {
    submit({ decision, annotations, generalFeedback: general.trim() || undefined });
  }

  if (phase !== "active") return <EndScreen phase={phase} t={t} />;

  return (
    <div className="wrap plan-wrap">
      <header className="masthead">
        <h1>{payload.title}</h1>
        {payload.subtitle && <div className="sub">{payload.subtitle}</div>}
      </header>

      {blocks.map((block, i) => {
        const commenting = i in comments;
        return (
          <div className={commenting ? "plan-block commenting" : "plan-block"} key={i}>
            <button className="comment-tag" onClick={() => openComment(i)} title={t.addComment}>
              {t.addComment}
            </button>
            <div className="md" dangerouslySetInnerHTML={{ __html: block.html }} />
            {commenting && (
              <div className="annot">
                <textarea
                  autoFocus
                  placeholder={t.commentPlaceholder}
                  value={comments[i]}
                  onChange={(e) => setComment(i, e.target.value)}
                />
                <button className="btn ghost sm" onClick={() => removeComment(i)}>
                  {t.remove}
                </button>
              </div>
            )}
          </div>
        );
      })}

      <section className="general">
        <label>{t.generalFeedback}</label>
        <textarea
          placeholder={t.generalFeedbackPlaceholder}
          value={general}
          onChange={(e) => setGeneral(e.target.value)}
        />
      </section>

      <div className="bar">
        <div className="inner">
          <span className="count">{t.annotationsCount(annotations.length)}</span>
          <span className="spacer" />
          <button className="btn ghost" onClick={cancel} disabled={busy} title={t.reviseHint}>
            {t.cancel}
          </button>
          <button className="btn" onClick={() => send("revise")} disabled={busy} title={t.reviseHint}>
            {t.requestChanges}
          </button>
          <button className="btn primary" onClick={() => send("approve")} disabled={busy} title={t.approveHint}>
            {t.approve}
          </button>
        </div>
      </div>
    </div>
  );
}
