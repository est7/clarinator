import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";
import { resolveLocale, strings } from "./i18n.ts";
import { ClarityApp } from "./clarity/ClarityApp.tsx";
import { PlanApp } from "./plan/PlanApp.tsx";

const boot = window.__CLARINATOR__;
const rootEl = document.getElementById("root")!;

if (!boot) {
  const tf = strings(resolveLocale());
  rootEl.innerHTML = `<div class="end err"><div class="mark">✕</div><h2>${tf.noPayloadTitle}</h2><p>${tf.noPayloadBody}</p></div>`;
} else {
  createRoot(rootEl).render(
    <StrictMode>{boot.mode === "plan" ? <PlanApp boot={boot} /> : <ClarityApp boot={boot} />}</StrictMode>,
  );
}
