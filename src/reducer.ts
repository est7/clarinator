// Pure branching engine. Given a validated payload + the current answers, decide
// which decisions are active, drop answers that fell out of the active set, and
// build the final result. No DOM, no IO — the frontend and the server both call
// these, and the tests pin every edge.

import type { Answer, Answers, ClarityDecision, ClarityPayload, ResultItem } from "./types.ts";

/** Is `dec`'s own guard satisfied by `answers` (ignoring whether the parent is active)? */
function guardSatisfied(dec: ClarityDecision, answers: Answers): boolean {
  if (!dec.show_if) return true;
  const parentAnswer = answers[dec.show_if.decision];
  if (!parentAnswer || parentAnswer.kind !== "option") return false;
  return dec.show_if.in.includes(parentAnswer.optionId);
}

/**
 * Ids of the decisions currently active. A decision is active iff its guard is
 * satisfied AND its parent (if any) is itself active — resolved top-down, which
 * is sound because `show_if.decision` always references an earlier decision.
 */
export function activeDecisionIds(payload: ClarityPayload, answers: Answers): Set<string> {
  const active = new Set<string>();
  for (const dec of payload.decisions) {
    const parentId = dec.show_if?.decision ?? null;
    const parentActive = parentId === null || active.has(parentId);
    if (parentActive && guardSatisfied(dec, answers)) active.add(dec.id);
  }
  return active;
}

/** Active decisions, in payload order. */
export function activeDecisions(payload: ClarityPayload, answers: Answers): ClarityDecision[] {
  const active = activeDecisionIds(payload, answers);
  return payload.decisions.filter((d) => active.has(d.id));
}

/** Drop answers whose decision is no longer active (e.g. after a parent re-pick). */
export function prune(payload: ClarityPayload, answers: Answers): Answers {
  const active = activeDecisionIds(payload, answers);
  const next: Answers = {};
  for (const [id, ans] of Object.entries(answers)) {
    if (active.has(id)) next[id] = ans;
  }
  return next;
}

/** Apply one answer then prune, so descendants of a changed parent are cleared. */
export function answer(
  payload: ClarityPayload,
  answers: Answers,
  decisionId: string,
  value: Answer,
): Answers {
  return prune(payload, { ...answers, [decisionId]: value });
}

function isAnswered(ans: Answer | undefined): boolean {
  if (!ans) return false;
  if (ans.kind === "custom") return ans.value.trim().length > 0;
  return true;
}

/** Active decision ids that still lack a valid answer. */
export function missing(payload: ClarityPayload, answers: Answers): string[] {
  return activeDecisions(payload, answers)
    .filter((d) => !isAnswered(answers[d.id]))
    .map((d) => d.id);
}

export function isComplete(payload: ClarityPayload, answers: Answers): boolean {
  return missing(payload, answers).length === 0;
}

/**
 * Build the submitted result: one item per ACTIVE decision, in order. Inactive
 * decisions are excluded. Throws if any active decision is unanswered — callers
 * must gate on `isComplete` first (the server re-checks as a trust boundary).
 */
export function buildResult(payload: ClarityPayload, answers: Answers): ResultItem[] {
  const stillMissing = missing(payload, answers);
  if (stillMissing.length > 0) {
    throw new Error(`cannot build result, unanswered active decisions: ${stillMissing.join(", ")}`);
  }
  return activeDecisions(payload, answers).map((dec) => {
    const ans = answers[dec.id] as Answer;
    if (ans.kind === "custom") {
      return { decisionId: dec.id, question: dec.question, optionId: null, answer: ans.value.trim(), custom: true };
    }
    const opt = dec.options.find((o) => o.id === ans.optionId);
    return {
      decisionId: dec.id,
      question: dec.question,
      optionId: ans.optionId,
      answer: opt ? opt.label : ans.optionId,
      custom: false,
    };
  });
}
