/** Draft name prefixes written only by the collector/curator; ordinary writers cannot claim them. */
export const RESERVED_DRAFT_PREFIXES = ["curator-", "raw-x-post-", "x-insight-", "collective-push-x-"];
export function isReservedDraftName(slug) {
  const lower = String(slug).toLowerCase();
  return RESERVED_DRAFT_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Canonical http(s) URL that is safe to emit as an RDF IRIREF, or an error. */
export function safeSourceIri(raw) {
  if (typeof raw !== "string" || raw.length > 2048 || /[<>"{}|^`\\\s\u0000-\u001f]/.test(raw)) throw new Error("sourceUrl contains characters not allowed in an IRI");
  let url;
  try { url = new URL(raw); } catch { throw new Error("sourceUrl is not a valid URL"); }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("sourceUrl must use http or https");
  if (url.username || url.password) throw new Error("sourceUrl must not embed credentials");
  const href = url.href;
  if (href.length > 2048 || /[<>"{}|^`\\\s\u0000-\u001f]/.test(href)) throw new Error("sourceUrl contains characters not allowed in an IRI");
  return href;
}
