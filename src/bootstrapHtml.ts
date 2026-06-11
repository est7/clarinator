import type { Bootstrap } from "./types.ts";

export function injectBootstrap(appHtml: string, boot: Bootstrap): string {
  const headClose = appHtml.toLowerCase().lastIndexOf("</head>");
  if (!appHtml || headClose === -1) {
    throw new Error("embedded UI (dist/app.html) is missing or has no </head> sentinel");
  }

  const safe = JSON.stringify(boot).replace(/</g, "\\u003c");
  const tag = `<script>window.__CLARINATOR__ = ${safe};</script>`;
  return `${appHtml.slice(0, headClose)}${tag}${appHtml.slice(headClose)}`;
}
