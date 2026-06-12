import { describe, expect, it } from "vitest";
import { validatePayload, validatePlanPayload, ValidationError } from "./validate.ts";

function base(): Record<string, unknown> {
  return {
    title: "Login PRD",
    context: "some context",
    decisions: [
      {
        id: "auth-method",
        question: "Which auth methods?",
        recommendation_reason: "reason long enough to pass",
        options: [
          { id: "magic-link", label: "Magic link", recommended: true },
          { id: "password", label: "Password", recommended: false },
        ],
      },
    ],
  };
}

describe("validatePayload — happy path", () => {
  it("accepts a minimal valid payload", () => {
    expect(() => validatePayload(base())).not.toThrow();
  });

  it("accepts a valid show_if referencing an earlier decision + existing option", () => {
    const p = base();
    (p.decisions as unknown[]).push({
      id: "password-strength",
      question: "Password policy?",
      recommendation_reason: "reason long enough to pass",
      show_if: { decision: "auth-method", in: ["password"] },
      options: [
        { id: "lenient", label: "Lenient", recommended: true },
        { id: "strict", label: "Strict", recommended: false },
      ],
    });
    expect(() => validatePayload(p)).not.toThrow();
  });

  it("accepts flow metadata for iterative clarity sessions", () => {
    const p = {
      ...base(),
      flow: {
        session_id: "login-prd",
        page_id: "scope",
        page_title: "Page 1: Scope",
        continue_label: "Next",
        done_label: "Finish",
        allow_done: true,
      },
    };
    expect(() => validatePayload(p)).not.toThrow();
  });
});

describe("validatePayload — graph rules", () => {
  function withSecond(showIf: unknown): Record<string, unknown> {
    const p = base();
    (p.decisions as unknown[]).push({
      id: "child",
      question: "Child question?",
      recommendation_reason: "reason long enough to pass",
      show_if: showIf,
      options: [
        { id: "a", label: "A", recommended: true },
        { id: "b", label: "B", recommended: false },
      ],
    });
    return p;
  }

  it("rejects show_if referencing an unknown decision", () => {
    expect(() => validatePayload(withSecond({ decision: "nope", in: ["a"] }))).toThrow(/unknown decision/);
  });

  it("rejects show_if referencing a later/self decision (forward ref)", () => {
    // child references itself → not earlier
    expect(() => validatePayload(withSecond({ decision: "child", in: ["a"] }))).toThrow(/itself|earlier/);
  });

  it("rejects show_if.in option id that does not exist on the parent", () => {
    expect(() => validatePayload(withSecond({ decision: "auth-method", in: ["ghost"] }))).toThrow(
      /not an option/,
    );
  });

  it("rejects empty show_if.in", () => {
    expect(() => validatePayload(withSecond({ decision: "auth-method", in: [] }))).toThrow(/at least one/);
  });

  it("rejects a forward reference to a decision defined after this one", () => {
    const p = base();
    // Insert a child BEFORE its parent target by ordering.
    (p.decisions as unknown[]).unshift({
      id: "early-child",
      question: "Early child?",
      recommendation_reason: "reason long enough to pass",
      show_if: { decision: "auth-method", in: ["password"] },
      options: [
        { id: "a", label: "A", recommended: true },
        { id: "b", label: "B", recommended: false },
      ],
    });
    expect(() => validatePayload(p)).toThrow(/earlier decision/);
  });
});

describe("validatePayload — field rules", () => {
  it("rejects unknown root keys", () => {
    expect(() => validatePayload({ ...base(), surprise: 1 })).toThrow(/unknown keys/);
  });

  it("rejects unknown flow keys", () => {
    expect(() => validatePayload({ ...base(), flow: { page_id: "scope", surprise: 1 } })).toThrow(/flow: unknown keys/);
  });

  it("rejects non-kebab flow ids", () => {
    expect(() => validatePayload({ ...base(), flow: { session_id: "Login PRD" } })).toThrow(/flow\.session_id/);
  });

  it("rejects a non-kebab id", () => {
    const p = base();
    (p.decisions as Record<string, unknown>[])[0]!.id = "Not_Kebab";
    expect(() => validatePayload(p)).toThrow(/kebab-case/);
  });

  it("rejects more than one recommended option", () => {
    const p = base();
    const opts = (p.decisions as Record<string, unknown>[])[0]!.options as Record<string, unknown>[];
    opts[1]!.recommended = true;
    expect(() => validatePayload(p)).toThrow(/exactly one option/);
  });

  it("rejects zero recommended options", () => {
    const p = base();
    const opts = (p.decisions as Record<string, unknown>[])[0]!.options as Record<string, unknown>[];
    opts[0]!.recommended = false;
    expect(() => validatePayload(p)).toThrow(/exactly one option/);
  });

  it("throws ValidationError instances with a field path", () => {
    try {
      validatePayload({ title: "", context: "c", decisions: [] });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as Error).message).toMatch(/^title:/);
    }
  });
});

describe("validatePlanPayload", () => {
  it("accepts a minimal plan", () => {
    expect(() => validatePlanPayload({ title: "Plan", plan: "## Goal\n\nDo the thing." })).not.toThrow();
  });

  it("rejects a missing plan body", () => {
    expect(() => validatePlanPayload({ title: "Plan" })).toThrow(/plan:/);
  });

  it("rejects unknown keys", () => {
    expect(() => validatePlanPayload({ title: "Plan", plan: "x", extra: 1 })).toThrow(/unknown keys/);
  });
});
