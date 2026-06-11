// @vitest-environment jsdom
// DOMPurify needs a faithful DOM; happy-dom (the default env) degrades it to
// text-only, so this file runs under jsdom — DOMPurify's standard test env.
import { describe, expect, it } from "vitest";
import { sanitizeHtml } from "./sanitize.ts";

describe("sanitizeHtml", () => {
  it("strips event handlers that could reach the submit token", () => {
    expect(sanitizeHtml('<img src=x onerror="fetch(\'/api/submit\')">')).not.toMatch(/onerror/i);
  });

  it("strips script tags", () => {
    const clean = sanitizeHtml("<script>alert(1)</script><p>plan</p>");
    expect(clean).not.toMatch(/<script/i);
    expect(clean).toMatch(/<p>plan<\/p>/);
  });

  it("keeps safe formatting (headings, code, lists)", () => {
    const clean = sanitizeHtml("<h2>Goal</h2><pre><code>x</code></pre><ul><li>a</li></ul>");
    expect(clean).toMatch(/<h2>Goal<\/h2>/);
    expect(clean).toMatch(/<code>x<\/code>/);
    expect(clean).toMatch(/<li>a<\/li>/);
  });

  it("neutralizes javascript: hrefs", () => {
    expect(sanitizeHtml('<a href="javascript:fetch(\'/api/cancel\')">x</a>')).not.toMatch(/javascript:/i);
  });
});
