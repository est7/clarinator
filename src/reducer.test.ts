import { describe, expect, it } from "vitest";
import type { Answers, ClarityPayload } from "./types.ts";
import {
  activeDecisionIds,
  answer,
  buildResult,
  isComplete,
  missing,
  prune,
  validateAnswers,
} from "./reducer.ts";

// A two-level tree:
//   auth-method (root): magic-link | password
//     password-strength  show_if auth-method in [password]
//       breach-check     show_if password-strength in [strict]
//   session-model (root): jwt | server-session
const tree: ClarityPayload = {
  title: "t",
  context: "c",
  decisions: [
    {
      id: "auth-method",
      question: "Which auth methods?",
      recommendation_reason: "reason long enough",
      options: [
        { id: "magic-link", label: "Magic link", recommended: true },
        { id: "password", label: "Password", recommended: false },
      ],
    },
    {
      id: "password-strength",
      question: "Password policy?",
      recommendation_reason: "reason long enough",
      show_if: { decision: "auth-method", in: ["password"] },
      options: [
        { id: "lenient", label: "Lenient", recommended: true },
        { id: "strict", label: "Strict", recommended: false },
      ],
    },
    {
      id: "breach-check",
      question: "Check breached password DB?",
      recommendation_reason: "reason long enough",
      show_if: { decision: "password-strength", in: ["strict"] },
      options: [
        { id: "yes", label: "Yes", recommended: true },
        { id: "no", label: "No", recommended: false },
      ],
    },
    {
      id: "session-model",
      question: "Session model?",
      recommendation_reason: "reason long enough",
      allow_custom: true,
      options: [
        { id: "jwt", label: "JWT", recommended: true },
        { id: "server-session", label: "Server session", recommended: false },
      ],
    },
  ],
};

const pick = (optionId: string): Answers[string] => ({ kind: "option", optionId });

describe("activeDecisionIds", () => {
  it("roots are active with no answers; guarded children hidden", () => {
    const active = activeDecisionIds(tree, {});
    expect([...active].sort()).toEqual(["auth-method", "session-model"]);
  });

  it("reveals a child when the parent guard is met", () => {
    const a: Answers = { "auth-method": pick("password") };
    expect(activeDecisionIds(tree, a).has("password-strength")).toBe(true);
  });

  it("keeps grandchild hidden until the intermediate guard is met", () => {
    const a: Answers = { "auth-method": pick("password"), "password-strength": pick("lenient") };
    const active = activeDecisionIds(tree, a);
    expect(active.has("password-strength")).toBe(true);
    expect(active.has("breach-check")).toBe(false);
  });

  it("reveals the grandchild through a two-level chain", () => {
    const a: Answers = { "auth-method": pick("password"), "password-strength": pick("strict") };
    expect(activeDecisionIds(tree, a).has("breach-check")).toBe(true);
  });

  it("a custom answer never satisfies an option-id guard", () => {
    const a: Answers = { "auth-method": { kind: "custom", value: "webauthn" } };
    expect(activeDecisionIds(tree, a).has("password-strength")).toBe(false);
  });
});

describe("prune + answer", () => {
  it("answering re-prunes descendants when a parent flips away", () => {
    let a: Answers = {};
    a = answer(tree, a, "auth-method", pick("password"));
    a = answer(tree, a, "password-strength", pick("strict"));
    a = answer(tree, a, "breach-check", pick("yes"));
    expect(Object.keys(a).sort()).toEqual(["auth-method", "breach-check", "password-strength"]);

    // Flip the root to magic-link → the whole password subtree must drop.
    a = answer(tree, a, "auth-method", pick("magic-link"));
    expect(Object.keys(a)).toEqual(["auth-method"]);
  });

  it("prune is idempotent on an already-consistent answer set", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": pick("jwt") };
    expect(prune(tree, a)).toEqual(a);
  });
});

describe("missing / isComplete", () => {
  it("requires every active decision answered", () => {
    expect(isComplete(tree, {})).toBe(false);
    expect(missing(tree, {}).sort()).toEqual(["auth-method", "session-model"]);
  });

  it("does not require hidden decisions", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": pick("jwt") };
    expect(isComplete(tree, a)).toBe(true);
  });

  it("treats blank custom text as unanswered", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": { kind: "custom", value: "  " } };
    expect(isComplete(tree, a)).toBe(false);
    expect(missing(tree, a)).toEqual(["session-model"]);
  });

  it("accepts non-blank custom text", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": { kind: "custom", value: "paseto" } };
    expect(isComplete(tree, a)).toBe(true);
  });
});

describe("buildResult", () => {
  it("excludes inactive decisions and maps option labels", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": pick("jwt") };
    const result = buildResult(tree, a);
    expect(result.map((r) => r.decisionId)).toEqual(["auth-method", "session-model"]);
    expect(result[0]).toMatchObject({ optionId: "magic-link", answer: "Magic link", custom: false });
  });

  it("includes revealed branch answers in tree order", () => {
    let a: Answers = {};
    a = answer(tree, a, "auth-method", pick("password"));
    a = answer(tree, a, "password-strength", pick("strict"));
    a = answer(tree, a, "breach-check", pick("yes"));
    a = answer(tree, a, "session-model", pick("jwt"));
    const result = buildResult(tree, a);
    expect(result.map((r) => r.decisionId)).toEqual([
      "auth-method",
      "password-strength",
      "breach-check",
      "session-model",
    ]);
  });

  it("emits custom answers with optionId null", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": { kind: "custom", value: "paseto" } };
    const result = buildResult(tree, a);
    expect(result[1]).toMatchObject({ optionId: null, answer: "paseto", custom: true });
  });

  it("throws when an active decision is unanswered", () => {
    expect(() => buildResult(tree, { "auth-method": pick("magic-link") })).toThrow(/unanswered/);
  });
});

describe("validateAnswers (server trust boundary)", () => {
  const good: Answers = { "auth-method": pick("magic-link"), "session-model": pick("jwt") };

  it("accepts a valid, complete answer set", () => {
    expect(validateAnswers(tree, good)).toEqual({ ok: true });
  });

  it("rejects an option id that does not exist on the decision", () => {
    expect(validateAnswers(tree, { ...good, "auth-method": pick("not-a-real-option") })).toMatchObject({ ok: false });
  });

  it("rejects a custom answer where allow_custom is not set", () => {
    const a: Answers = { ...good, "auth-method": { kind: "custom", value: "webauthn" } };
    expect(validateAnswers(tree, a)).toMatchObject({ ok: false, error: /custom answer not allowed/ });
  });

  it("accepts a custom answer where allow_custom is set", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": { kind: "custom", value: "paseto" } };
    expect(validateAnswers(tree, a)).toEqual({ ok: true });
  });

  it("rejects a blank custom answer", () => {
    const a: Answers = { "auth-method": pick("magic-link"), "session-model": { kind: "custom", value: "   " } };
    expect(validateAnswers(tree, a)).toMatchObject({ ok: false });
  });

  it("rejects an answer for an inactive decision", () => {
    const a: Answers = { ...good, "password-strength": pick("strict") };
    expect(validateAnswers(tree, a)).toMatchObject({ ok: false, error: /inactive/ });
  });

  it("rejects an incomplete set", () => {
    expect(validateAnswers(tree, { "auth-method": pick("magic-link") })).toMatchObject({ ok: false });
  });
});
