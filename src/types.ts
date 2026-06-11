// Shared data model for clarinator's `clarity` mode: a branching decision tree.
// A decision becomes *active* only when its `show_if` guard is satisfied by an
// earlier decision's answer. Inactive decisions are hidden and excluded from the
// submitted result. The tree is acyclic by construction: `show_if.decision` must
// reference a decision that appears earlier in `decisions[]`.

export interface ClarityOption {
  id: string;
  label: string;
  description?: string;
  recommended: boolean;
  reason?: string;
}

export interface ShowIf {
  /** Parent decision id; must appear earlier in `decisions[]`. */
  decision: string;
  /** This decision is active iff the parent's chosen option id is in this list. */
  in: string[];
}

export interface ClarityDecision {
  id: string;
  question: string;
  recommendation_reason: string;
  options: ClarityOption[];
  /** Allow a free-text answer in addition to the options. */
  allow_custom?: boolean;
  /** Conditional-visibility guard. Absent → always active (a root decision). */
  show_if?: ShowIf;
}

export interface ClarityPayload {
  title: string;
  subtitle?: string;
  context: string;
  decisions: ClarityDecision[];
}

/** A single decision's answer: a picked option, or a free-text custom value. */
export type Answer =
  | { kind: "option"; optionId: string }
  | { kind: "custom"; value: string };

/** Map of decision id → answer. Only answered decisions appear. */
export type Answers = Record<string, Answer>;

/** One resolved decision in the submitted result. */
export interface ResultItem {
  decisionId: string;
  question: string;
  /** Chosen option id, or null when the answer was free-text. */
  optionId: string | null;
  /** Human-readable answer: the option label, or the custom text. */
  answer: string;
  custom: boolean;
}

export interface ClaritySubmission {
  mode: "clarity";
  title: string;
  result: ResultItem[];
}

/** Injected into the page at launch as `window.__CLARINATOR__`. */
export interface Bootstrap {
  mode: "clarity";
  token: string;
  /** UI-chrome language hint (e.g. "zh", "en"); falls back to browser, then English. */
  locale?: string;
  payload: ClarityPayload;
}

declare global {
  interface Window {
    __CLARINATOR__?: Bootstrap;
  }
}
