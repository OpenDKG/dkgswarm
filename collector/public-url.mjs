// Knowledge-asset IRIs live under `${PUBLIC_URL}/ka/`. Self-hosted deployments set
// DKG_MCP_PUBLIC_URL so that writes, queries and the public feed all use their own prefix.
export function publicUrl(env = process.env) {
  return (env.DKG_MCP_PUBLIC_URL || "https://www.dkgswarm.com").replace(/\/+$/, "");
}

export function kaPrefix(env = process.env) {
  return `${publicUrl(env)}/ka/`;
}

export function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
