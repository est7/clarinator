// UI-chrome localization. Decision *content* (questions, options, context) is
// authored by the agent in the conversation's language and passed through as-is;
// only the fixed chrome below is translated here. The agent passes `locale` in
// the bootstrap; absent that, we fall back to the browser language, then English.

export type Locale = "en" | "zh";

export interface Strings {
  whyDefault: string;
  recommended: string;
  somethingElse: string;
  customPlaceholder: string;
  answered: (answered: number, total: number) => string;
  cancel: string;
  send: string;
  sentTitle: string;
  sentBody: string;
  cancelledTitle: string;
  cancelledBody: string;
  errorTitle: string;
  errorBody: string;
  noPayloadTitle: string;
  noPayloadBody: string;
  // plan mode
  addComment: string;
  commentPlaceholder: string;
  generalFeedback: string;
  generalFeedbackPlaceholder: string;
  annotationsCount: (n: number) => string;
  approve: string;
  requestChanges: string;
  approveHint: string;
  reviseHint: string;
  remove: string;
}

const EN: Strings = {
  whyDefault: "Why this default:",
  recommended: "recommended",
  somethingElse: "Something else…",
  customPlaceholder: "Type your own answer",
  answered: (a, n) => `${a}/${n} answered`,
  cancel: "Cancel",
  send: "Send to agent",
  sentTitle: "Sent back to the agent",
  sentBody: "You can close this tab.",
  cancelledTitle: "Cancelled",
  cancelledBody: "The agent was told you did not answer. You can close this tab.",
  errorTitle: "Connection lost",
  errorBody: "The clarinator server is no longer reachable. Return to your terminal.",
  noPayloadTitle: "No payload",
  noPayloadBody: "This page must be served by the clarinator server.",
  addComment: "Comment",
  commentPlaceholder: "What should change here?",
  generalFeedback: "Overall feedback",
  generalFeedbackPlaceholder: "Anything not tied to a specific block (optional)",
  annotationsCount: (n) => (n === 1 ? "1 comment" : `${n} comments`),
  approve: "Approve",
  requestChanges: "Request changes",
  approveHint: "Approve the plan — the agent starts implementing.",
  reviseHint: "Send your comments back; the agent revises before coding.",
  remove: "Remove",
};

const ZH: Strings = {
  whyDefault: "推荐理由:",
  recommended: "推荐",
  somethingElse: "其他…",
  customPlaceholder: "填你自己的答案",
  answered: (a, n) => `已答 ${a}/${n}`,
  cancel: "取消",
  send: "提交给 agent",
  sentTitle: "已回传给 agent",
  sentBody: "可以关掉这个标签页了。",
  cancelledTitle: "已取消",
  cancelledBody: "已告诉 agent 你没有作答,关掉标签页即可。",
  errorTitle: "连接断开",
  errorBody: "clarinator server 已不可达,回到终端查看。",
  noPayloadTitle: "缺少 payload",
  noPayloadBody: "这个页面必须由 clarinator server 提供。",
  addComment: "批注",
  commentPlaceholder: "这里要改什么?",
  generalFeedback: "总体反馈",
  generalFeedbackPlaceholder: "跟具体段落无关的意见(可选)",
  annotationsCount: (n) => `${n} 条批注`,
  approve: "通过",
  requestChanges: "要求修改",
  approveHint: "通过方案,agent 开始实现。",
  reviseHint: "把批注回传给 agent,先改方案再写码。",
  remove: "删除",
};

const TABLE: Record<Locale, Strings> = { en: EN, zh: ZH };

export const SUPPORTED: Locale[] = ["en", "zh"];

/** Normalize a BCP-47-ish tag (e.g. "zh-CN", "ZH") to a supported Locale. */
export function normalizeLocale(tag: string | undefined | null): Locale | null {
  if (!tag) return null;
  const lc = tag.toLowerCase();
  if (lc.startsWith("zh")) return "zh";
  if (lc.startsWith("en")) return "en";
  return null;
}

/** Resolve the active locale: explicit pref → browser language → English. */
export function resolveLocale(pref?: string): Locale {
  const browser = typeof navigator !== "undefined" ? navigator.language : undefined;
  return normalizeLocale(pref) ?? normalizeLocale(browser) ?? "en";
}

export function strings(locale: Locale): Strings {
  return TABLE[locale] ?? EN;
}
