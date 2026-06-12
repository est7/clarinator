import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { ClarityApp } from "./ClarityApp.tsx";
import type { ClarityBootstrap } from "../types.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let host: HTMLDivElement | undefined;

function renderApp(boot: ClarityBootstrap): HTMLDivElement {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => {
    root?.render(<ClarityApp boot={boot} />);
  });
  return host;
}

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  host?.remove();
  root = undefined;
  host = undefined;
});

describe("ClarityApp flow actions", () => {
  const boot: ClarityBootstrap = {
    mode: "clarity",
    token: "tok",
    locale: "en",
    payload: {
      title: "Final page",
      context: "Confirm the terminal page actions.",
      flow: {
        session_id: "login-prd",
        page_id: "final",
        done_label: "Finish",
      },
      decisions: [
        {
          id: "confirm",
          question: "Ready to finish?",
          recommendation_reason: "reason long enough to pass",
          options: [
            { id: "yes", label: "Yes", recommended: true },
            { id: "no", label: "No", recommended: false },
          ],
        },
      ],
    },
  };

  it("leaves next-page decisions to the agent", () => {
    const el = renderApp(boot);
    const buttons = [...el.querySelectorAll("button")].map((button) => button.textContent?.trim());

    expect(buttons).toContain("Send to agent");
    expect(buttons).not.toContain("Finish");
    expect(buttons).not.toContain("Continue");
    expect(el.querySelectorAll("button.btn.primary")).toHaveLength(1);
    expect(el.querySelector("button.btn.primary")?.textContent?.trim()).toBe("Send to agent");
  });
});
