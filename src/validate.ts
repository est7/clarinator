// Static, answer-independent validation of a clarity payload. Fail-closed with an
// exact field path, mirroring the strictness of the original render.py. The server
// runs this before serving; tests pin the contract.

import type { ClarityPayload, ClarityDecision, PlanPayload } from "./types.ts";

export class ValidationError extends Error {}

const KEBAB = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

const MAX_DECISIONS = 40;

function require(cond: boolean, path: string, msg: string): asserts cond {
  if (!cond) throw new ValidationError(`${path}: ${msg}`);
}

function str(
  val: unknown,
  path: string,
  { min = 0, max }: { min?: number; max?: number } = {},
): asserts val is string {
  require(typeof val === "string", path, `expected string, got ${typeof val}`);
  const s = val as string;
  require(s.length >= min, path, `too short (${s.length} < ${min})`);
  if (max !== undefined) require(s.length <= max, path, `too long (${s.length} > ${max})`);
}

function kebab(val: unknown, path: string, max: number): asserts val is string {
  str(val, path, { min: 1, max });
  require(KEBAB.test(val as string), path, `must be kebab-case (got ${JSON.stringify(val)})`);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Throws ValidationError on the first violation. Returns the typed payload. */
export function validatePayload(data: unknown): ClarityPayload {
  require(isObject(data), "<root>", "expected object");
  const allowed = new Set(["title", "subtitle", "context", "flow", "decisions"]);
  const extra = Object.keys(data).filter((k) => !allowed.has(k));
  require(extra.length === 0, "<root>", `unknown keys: ${extra.sort().join(", ")}`);

  str(data.title, "title", { min: 1, max: 120 });
  if (data.subtitle !== undefined) str(data.subtitle, "subtitle", { max: 160 });
  str(data.context, "context", { min: 1, max: 1200 });
  if (data.flow !== undefined) validateFlow(data.flow);

  require(Array.isArray(data.decisions), "decisions", "expected array");
  const decisions = data.decisions as unknown[];
  require(
    decisions.length >= 1 && decisions.length <= MAX_DECISIONS,
    "decisions",
    `must have 1–${MAX_DECISIONS} items (got ${decisions.length})`,
  );

  const seenDecisionIds = new Set<string>();
  const optionIdsByDecision = new Map<string, Set<string>>();

  decisions.forEach((raw, i) => {
    const dp = `decisions[${i}]`;
    require(isObject(raw), dp, "expected object");
    const dec = raw as Record<string, unknown>;
    const allowedKeys = new Set([
      "id",
      "question",
      "options",
      "recommendation_reason",
      "allow_custom",
      "show_if",
    ]);
    const dExtra = Object.keys(dec).filter((k) => !allowedKeys.has(k));
    require(dExtra.length === 0, dp, `unknown keys: ${dExtra.sort().join(", ")}`);

    kebab(dec.id, `${dp}.id`, 64);
    const id = dec.id as string;
    require(!seenDecisionIds.has(id), `${dp}.id`, `duplicate id ${JSON.stringify(id)}`);
    seenDecisionIds.add(id);

    str(dec.question, `${dp}.question`, { min: 6, max: 240 });
    str(dec.recommendation_reason, `${dp}.recommendation_reason`, { min: 12, max: 600 });

    if (dec.allow_custom !== undefined)
      require(typeof dec.allow_custom === "boolean", `${dp}.allow_custom`, "expected boolean");

    require(Array.isArray(dec.options), `${dp}.options`, "expected array");
    const options = dec.options as unknown[];
    require(
      options.length >= 2 && options.length <= 5,
      `${dp}.options`,
      `must have 2–5 items (got ${options.length})`,
    );

    let recCount = 0;
    const seenOptionIds = new Set<string>();
    options.forEach((rawOpt, j) => {
      const op = `${dp}.options[${j}]`;
      require(isObject(rawOpt), op, "expected object");
      const opt = rawOpt as Record<string, unknown>;
      const allowedOpt = new Set(["id", "label", "description", "recommended", "reason"]);
      const oExtra = Object.keys(opt).filter((k) => !allowedOpt.has(k));
      require(oExtra.length === 0, op, `unknown keys: ${oExtra.sort().join(", ")}`);

      kebab(opt.id, `${op}.id`, 48);
      const oid = opt.id as string;
      require(!seenOptionIds.has(oid), `${op}.id`, `duplicate within decision: ${JSON.stringify(oid)}`);
      seenOptionIds.add(oid);

      str(opt.label, `${op}.label`, { min: 1, max: 80 });
      if (opt.description !== undefined) str(opt.description, `${op}.description`, { max: 400 });
      if (opt.reason !== undefined) str(opt.reason, `${op}.reason`, { max: 400 });
      require(typeof opt.recommended === "boolean", `${op}.recommended`, "expected boolean");
      if (opt.recommended) recCount++;
    });
    require(recCount === 1, `${dp}.options`, `exactly one option must have recommended=true (got ${recCount})`);

    optionIdsByDecision.set(id, seenOptionIds);
  });

  // Second pass: show_if guards. Reference must be an EARLIER decision (→ DAG by
  // construction, no cycle check needed), and `in` ids must exist on the parent.
  const orderIndex = new Map<string, number>();
  (decisions as Record<string, unknown>[]).forEach((dec, i) => orderIndex.set(dec.id as string, i));

  (decisions as Record<string, unknown>[]).forEach((dec, i) => {
    if (dec.show_if === undefined) return;
    const sp = `decisions[${i}].show_if`;
    require(isObject(dec.show_if), sp, "expected object");
    const si = dec.show_if as Record<string, unknown>;
    const siExtra = Object.keys(si).filter((k) => k !== "decision" && k !== "in");
    require(siExtra.length === 0, sp, `unknown keys: ${siExtra.sort().join(", ")}`);

    kebab(si.decision, `${sp}.decision`, 64);
    const parentId = si.decision as string;
    require(parentId !== dec.id, `${sp}.decision`, "decision cannot reference itself");
    require(seenDecisionIds.has(parentId), `${sp}.decision`, `references unknown decision ${JSON.stringify(parentId)}`);
    require(
      (orderIndex.get(parentId) as number) < i,
      `${sp}.decision`,
      `must reference an earlier decision (parent ${JSON.stringify(parentId)} appears at/after this one)`,
    );

    require(Array.isArray(si.in), `${sp}.in`, "expected array");
    const inArr = si.in as unknown[];
    require(inArr.length >= 1, `${sp}.in`, "must list at least one option id");
    const parentOptions = optionIdsByDecision.get(parentId) as Set<string>;
    inArr.forEach((oid, k) => {
      str(oid, `${sp}.in[${k}]`, { min: 1 });
      require(
        parentOptions.has(oid as string),
        `${sp}.in[${k}]`,
        `${JSON.stringify(oid)} is not an option of decision ${JSON.stringify(parentId)}`,
      );
    });
  });

  return data as unknown as ClarityPayload;
}

function validateFlow(raw: unknown): void {
  require(isObject(raw), "flow", "expected object");
  const allowed = new Set(["session_id", "page_id", "page_title", "continue_label", "done_label", "allow_done"]);
  const extra = Object.keys(raw).filter((k) => !allowed.has(k));
  require(extra.length === 0, "flow", `unknown keys: ${extra.sort().join(", ")}`);
  if (raw.session_id !== undefined) kebab(raw.session_id, "flow.session_id", 80);
  if (raw.page_id !== undefined) kebab(raw.page_id, "flow.page_id", 80);
  if (raw.page_title !== undefined) str(raw.page_title, "flow.page_title", { min: 1, max: 120 });
  if (raw.continue_label !== undefined) str(raw.continue_label, "flow.continue_label", { min: 1, max: 40 });
  if (raw.done_label !== undefined) str(raw.done_label, "flow.done_label", { min: 1, max: 40 });
  if (raw.allow_done !== undefined) require(typeof raw.allow_done === "boolean", "flow.allow_done", "expected boolean");
}

/** Convenience: a decision's parent id, or null for a root decision. */
export function parentOf(dec: ClarityDecision): string | null {
  return dec.show_if?.decision ?? null;
}

/** Validate a plan payload (Step 2). Throws ValidationError on the first violation. */
export function validatePlanPayload(data: unknown): PlanPayload {
  require(isObject(data), "<root>", "expected object");
  const allowed = new Set(["title", "subtitle", "plan"]);
  const extra = Object.keys(data).filter((k) => !allowed.has(k));
  require(extra.length === 0, "<root>", `unknown keys: ${extra.sort().join(", ")}`);

  str(data.title, "title", { min: 1, max: 120 });
  if (data.subtitle !== undefined) str(data.subtitle, "subtitle", { max: 160 });
  str(data.plan, "plan", { min: 1, max: 100000 });

  return data as unknown as PlanPayload;
}
