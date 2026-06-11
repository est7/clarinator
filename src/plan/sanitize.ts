import DOMPurify from "dompurify";

// The plan Markdown is agent-authored from repo/user content and rendered into a
// page that holds the submit token. Any raw HTML in it (e.g. `<img onerror=…>`)
// would otherwise become active DOM able to forge /api/submit or exfiltrate the
// payload. Sanitize the rendered HTML so formatting survives but scripts and
// event handlers are stripped. DOMPurify defaults already strip <script>, event
// handlers, and javascript: URLs while keeping standard formatting tags.
export function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html);
}
