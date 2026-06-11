import { describe, expect, it } from "vitest";
import { injectBootstrap } from "./bootstrapHtml.ts";
import type { Bootstrap } from "./types.ts";

const boot: Bootstrap = {
  mode: "plan",
  token: "tok",
  payload: { title: "Plan", plan: "Ship it." },
};

describe("injectBootstrap", () => {
  it("injects before the real closing head tag, not a literal inside inline script", () => {
    const html = [
      "<html><head>",
      '<script>const template = "<html><head></head><body>";</script>',
      "<style>body{color:black}</style>",
      "</head><body><div id=\"root\"></div></body></html>",
    ].join("");

    const out = injectBootstrap(html, boot);
    const fakeHeadClose = out.indexOf("</head>");
    const realHeadClose = out.lastIndexOf("</head>");
    const injected = out.indexOf("window.__CLARINATOR__");

    expect(fakeHeadClose).toBeLessThan(injected);
    expect(injected).toBeLessThan(realHeadClose);
  });

  it("escapes HTML tag starts in the JSON bootstrap payload", () => {
    const out = injectBootstrap("<html><head></head><body></body></html>", {
      mode: "plan",
      token: "tok",
      payload: { title: "</script><img src=x onerror=alert(1)>", plan: "Ship it." },
    });

    expect(out).not.toContain("</script><img");
    expect(out).toContain("\\u003c/script>");
  });

  it("rejects malformed app HTML", () => {
    expect(() => injectBootstrap("<html></html>", boot)).toThrow(/<\/head>/);
  });
});
