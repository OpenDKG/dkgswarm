import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

// X is read only through the official X API v2 with an app-only bearer token from the operator's own
// X developer project (WATCH_X_API_BEARER). Without it, X collection is off. No guest tokens, internal
// web-client endpoints, session cookies or client-transaction headers are used.
const X_API_BASE = "https://api.x.com/2";
const X_TWEET_FIELDS = "created_at,author_id,referenced_tweets,note_tweet";
const NS = "https://www.dkgswarm.com/ontology/x/";
const CURATOR_NS = "https://www.dkgswarm.com/ontology/curator/";
const TRUSTED_PUSH_ACCOUNTS = ["DrevZiga", "BranaRakic", "umanitek", "origin_trail"];
const OFFICIAL_ACCOUNTS = ["origin_trail", "origintraildev", "umanitek"];
const PUSH_WINDOW_MS = 30 * 60000;
const MAX_DKG_ATTEMPTS = 12;
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const SCHEMA = "https://schema.org/";
const XSD = "http://www.w3.org/2001/XMLSchema#";
const now = () => new Date().toISOString();
const lit = (value) => JSON.stringify(String(value ?? ""));
const typed = (value, type) => `${lit(value)}^^<${XSD}${type}>`;
export function normalizeXHandle(value, withAt = false) {
  const handle = String(value || "").trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) throw new Error("X handle must be 1-15 letters, numbers, or underscores");
  return withAt ? `@${handle}` : handle;
}

const normalizeHandle = (value) => {
  try { return normalizeXHandle(value); } catch { return ""; }
};

function uniqueHandles(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function isSharedAsset(body) {
  return body?.memoryLayer === "SWM" || body?.state === "promoted" || body?.swmShared === true
    || body?.shared === true || String(body?.status || "").startsWith("swm-shared");
}

export function isWorkingAsset(body) {
  return body?.memoryLayer === "WM" || body?.state === "created" || body?.state === "finalized"
    || body?.status === "wm-draft" || body?.status === "wm-sealed" || body?.written > 0;
}

export function dkgHealth(status) {
  const pendingDkg = status.queue.filter((row) => ["raw-dkg", "derived-dkg"].includes(row.stage) && row.status === "pending")
    .reduce((count, row) => count + row.count, 0);
  const retryingDkg = status.retryingDkg;
  return { ok: status.dkgFailures.length === 0 && retryingDkg === 0, pendingDkg, retryingDkg,
    quarantinedDkg: status.dkgFailures.length };
}

export function hasQueryContent(body) {
  const result = body?.result;
   if (result?.type === "boolean") return result.value === true || result.value === "true" || result.boolean === true;
  if (result?.type === "bindings") return Array.isArray(result.bindings) && result.bindings.length > 0;
  if (result?.type === "quads") return Array.isArray(result.quads) && result.quads.length > 0;
  return false;
}

/**
 * Maps one X API v2 post (plus `includes.users`) to the collector's post shape. When an expected
 * account is given, posts whose author id or username does not match are dropped.
 */
export function postFromXApi(tweet, usersById, expected = {}) {
  const id = String(tweet?.id || "");
  const author = usersById.get(String(tweet?.author_id || ""));
  const screen = author?.username || "";
  const text = String(tweet?.note_tweet?.text || tweet?.text || "");
  if (!id || !text || !screen) return null;
  if (expected.userId && String(tweet.author_id) !== String(expected.userId)) return null;
  if (expected.screen && screen.toLowerCase() !== String(expected.screen).toLowerCase()) return null;
  const refs = Array.isArray(tweet.referenced_tweets) ? tweet.referenced_tweets : [];
  return {
    post_id: id,
    account: `@${screen}`,
    post_url: `https://x.com/${screen}/status/${id}`,
    summary: text.replace(/\s+/g, " ").trim(),
    created_at: tweet.created_at || "",
    isReply: refs.some((ref) => ref?.type === "replied_to"),
    isRt: refs.some((ref) => ref?.type === "retweeted") || /^RT @/i.test(text),
    authorVerified: Boolean(author && tweet.author_id),
  };
}

export function postsFromXApi(body, expected = {}) {
  const usersById = new Map((body?.includes?.users || []).map((user) => [String(user.id), user]));
  return (Array.isArray(body?.data) ? body.data : [])
    .map((tweet) => postFromXApi(tweet, usersById, expected))
    .filter(Boolean);
}

export function shouldSkipPost(post, sourceTier, skipReplies, skipRts) {
  const collectAll = sourceTier === "approved-writer" || sourceTier === "swarm-member";
  return !collectAll && ((skipReplies && post.isReply) || (skipRts && post.isRt));
}

export function shouldNotifyPost(post) {
  return !post.isReply && !post.isRt;
}

export function trustedPushEligible(post, at = Date.now()) {
  const account = normalizeHandle(post.account).toLowerCase();
  const created = Date.parse(post.created_at);
  return post.authorVerified === true && TRUSTED_PUSH_ACCOUNTS.some((handle) => handle.toLowerCase() === account)
    && /^\d{8,22}$/.test(String(post.post_id))
    && post.post_url === `https://x.com/${normalizeHandle(post.account)}/status/${post.post_id}`
    && shouldNotifyPost(post) && String(post.summary || "").trim().length > 0
    && Number.isFinite(created) && created <= at && at < created + PUSH_WINDOW_MS;
}

export function buildTrustedPush(post) {
  const id = String(post.post_id);
  const subject = `https://www.dkgswarm.com/ka/collective-push-x-${id}`;
  const target = `https://x.com/i/status/${id}`;
  const issuedAt = new Date(Date.parse(post.created_at)).toISOString();
  const expiresAt = new Date(Date.parse(post.created_at) + PUSH_WINDOW_MS).toISOString();
  return { name: `collective-push-x-${id}`, subject, target, expiresAt, quads: [
    { subject, predicate: RDF_TYPE, object: `${CURATOR_NS}CollectivePush` },
    { subject, predicate: `${CURATOR_NS}targetPost`, object: target },
    { subject, predicate: `${CURATOR_NS}publisher`, object: lit(post.account) },
    { subject, predicate: `${CURATOR_NS}sourceTier`, object: lit("trusted-source-direct") },
    { subject, predicate: `${CURATOR_NS}claimStatus`, object: lit("coordination request; claims require independent verification") },
    { subject, predicate: `${CURATOR_NS}proposedAngle`, object: lit(`Discuss ${post.account} post in your own voice; verify claims independently`) },
    { subject, predicate: "http://www.w3.org/2000/01/rdf-schema#comment", object: lit(post.summary) },
    { subject, predicate: `${SCHEMA}identifier`, object: lit(id) },
    { subject, predicate: `${SCHEMA}dateCreated`, object: lit(issuedAt) },
    { subject, predicate: `${SCHEMA}expires`, object: lit(expiresAt) },
  ] };
}

function assetIdentity(name) {
  const raw = /^raw-x-post-(\d+)$/.exec(name);
  if (raw) return { subject: `https://x.com/i/status/${raw[1]}`, type: `${SCHEMA}SocialMediaPosting` };
  const derived = /^x-insight-(\d+)$/.exec(name);
  if (derived) return { subject: `${NS}classification/${derived[1]}`, type: `${NS}Classification` };
  const push = /^collective-push-x-(\d+)$/.exec(name);
  if (push) return { subject: `https://www.dkgswarm.com/ka/${name}`, type: `${CURATOR_NS}CollectivePush` };
  return null;
}

function loadToken() {
  try {
    const raw = fs.readFileSync(process.env.DKG_API_TOKEN_FILE || "/root/.dkg/auth.token", "utf8");
    return (raw.split(/\n/).find((line) => line.trim() && !line.trim().startsWith("#")) || "").trim();
  } catch {
    return "";
  }
}

const UNSAFE_IRI_CHARS_RE = /[<>"\\{}|^`\s\u0000-\u001f\u007f]/;

function sanitizeExtractedUrl(raw) {
  const trimmed = String(raw || "").replace(/[.,);!?]+$/, "");
  if (!trimmed || UNSAFE_IRI_CHARS_RE.test(trimmed)) return "";
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "";
    const normalized = parsed.toString();
    return UNSAFE_IRI_CHARS_RE.test(normalized) ? "" : normalized;
  } catch {
    return "";
  }
}

function relationships(text) {
  const value = String(text || "");
  return {
    mentions: [...new Set([...value.matchAll(/(^|[^\w])@([A-Za-z0-9_]{1,15})/g)].map((match) => `@${match[2]}`))],
    hashtags: [...new Set([...value.matchAll(/(^|[^\w])#([\p{L}\p{N}_]+)/gu)].map((match) => `#${match[2]}`))],
    links: [...new Set((value.match(/https?:\/\/[^\s<>"\\{}|^`\u0000-\u001f\u007f]+/g) || []).map(sanitizeExtractedUrl).filter(Boolean))],
  };
}

export function classifyPost(post, officialAccounts = [], options = {}) {
  const text = String(post.summary || "");
  const lower = text.toLowerCase();
  const account = normalizeHandle(post.account).toLowerCase();
  const official = officialAccounts.map((item) => normalizeHandle(item).toLowerCase()).includes(account);
  const sourceTier = official ? "official" : String(options.sourceTier || "discovery");
  const evidence = [];
  const strongSignals = [
    [/(^|\W)\$trac\b/i, "$TRAC"],
    [/@origin_trail\b/i, "@origin_trail"],
    [/@origintraildev\b/i, "@origintraildev"],
    [/@umanitek\b/i, "@umanitek"],
    [/\bumanitek\b/i, "Umanitek"],
    [/@branar[a]?kic\b/i, "@BranaRakic"],
    [/\borigintrail\b/i, "OriginTrail"],
    [/\bdkg\s*v?10\b/i, "DKG V10"],
    [/\bdkgcon\b/i, "DKGcon"],
    [/\bdecentralized knowledge graph\b/i, "decentralized knowledge graph"],
    [/\bverifiable internet for ai\b/i, "Verifiable Internet for AI"],
    [/\bneuroweb\b/i, "NeuroWeb"],
    [/\bchatdkg\b/i, "ChatDKG"],
    [/\bknowledge asset(?:s)?\b/i, "Knowledge Assets"],
    [/\bknowledge mining\b/i, "knowledge mining"],
    [/\bparanet(?:s)?\b/i, "paranets"],
    [/\bual\b.*\b(?:dkg|knowledge asset)\b|\b(?:dkg|knowledge asset).*\bual\b/i, "UAL"],
  ];
  for (const [pattern, label] of strongSignals) if (pattern.test(text)) evidence.push(label);
  const contextualDkg = /\bdkg\b/i.test(text) && /(origintrail|knowledge graph|knowledge asset|verifiable|neuroweb|trac|paranet|umanitek)/i.test(text);
  if (contextualDkg) evidence.push("contextual DKG");
  const ecosystemContext = /(origintrail|\$trac|@origin_trail|@origintraildev|umanitek|neuroweb|decentralized knowledge graph)/i.test(text);
  const adoptionContext = /(gs1|scan|sbb|rail|supply chain|digital product passport|trusted ai|verifiable ai|decentralized ai|provenance|real world adoption|network revenue|staking|delegat(?:e|ion|ing))/i.test(text);
  if (ecosystemContext && adoptionContext) evidence.push("ecosystem adoption context");
  if (official) evidence.unshift(`official account @${normalizeHandle(post.account)}`);

  let category = "unrelated";
  let confidence = 0;
  let score = 0;
  if (official) {
    category = "official-announcement";
    confidence = 1;
    score = 100;
  } else if (sourceTier === "approved-writer") {
    category = "approved-writer-post";
    confidence = 0.95;
    score = 85;
    evidence.unshift(`approved writer @${normalizeHandle(post.account)}`);
  } else if (sourceTier === "swarm-member") {
    category = "swarm-member-post";
    confidence = 0.9;
    score = 75;
    evidence.unshift(`registered swarm member @${normalizeHandle(post.account)}`);
  } else if (evidence.length > 0) {
    category = "ecosystem-signal";
    confidence = Math.min(0.98, 0.72 + evidence.length * 0.08);
    score = Math.min(90, 35 + evidence.length * 15 + (options.searchTier ? Math.max(0, 20 - options.searchTier * 4) : 0));
  }

  // Bare TRAC and bare DKG are ambiguous; neither is sufficient evidence.
  const ambiguousOnly = evidence.length === 0 && (/\btrac\b/i.test(lower) || /\bdkg\b/i.test(lower));
  const thinDiscovery = sourceTier === "discovery" && (text.trim().length < 40 ||
    (evidence.length === 1 && evidence[0] === "$TRAC") ||
    (/\b(?:price target|buy now|airdrop|giveaway)\b/i.test(text) && evidence.length < 3));
  if (thinDiscovery) { category = "unrelated"; confidence = 0; score = 0; }
  // Support watches such as @CredibleCrypto post on many topics. Keep only OriginTrail, Umanitek, or TRAC.
  const offTopicSupport = sourceTier === "ecosystem-account" && !ecosystemContext && !evidence.includes("$TRAC");
  if (offTopicSupport) { category = "unrelated"; confidence = 0; score = 0; }
  return {
    relevant: category !== "unrelated",
    category,
    confidence: Number(confidence.toFixed(2)),
    evidence,
    score,
    sourceTier,
    searchTier: options.searchTier || null,
    rejectionReason: category === "unrelated" ? (offTopicSupport ? "off-topic-support" : ambiguousOnly ? "ambiguous-keyword-only" : thinDiscovery ? "thin-discovery" : "no-ecosystem-signal") : "",
    evidenceLevel: official ? "primary-source-self-report" : category === "ecosystem-signal" ? "source-observation" : "none",
    relationships: relationships(text),
  };
}

export function buildAssets(post, classification, observedAt = now()) {
  const id = String(post.post_id);
  const postUri = `https://x.com/i/status/${id}`;
  const accountName = normalizeHandle(post.account);
  const accountUri = `https://x.com/${encodeURIComponent(accountName)}`;
  const analysisUri = `${NS}classification/${id}`;
  const rawName = `raw-x-post-${id}`;
  const insightName = `x-insight-${id}`;
  const raw = [
    { subject: postUri, predicate: RDF_TYPE, object: `${SCHEMA}SocialMediaPosting` },
    { subject: postUri, predicate: `${SCHEMA}identifier`, object: lit(id) },
    { subject: postUri, predicate: `${SCHEMA}url`, object: post.post_url },
    { subject: postUri, predicate: `${SCHEMA}articleBody`, object: lit(post.summary) },
    { subject: postUri, predicate: `${SCHEMA}author`, object: accountUri },
    { subject: postUri, predicate: `${NS}observedAt`, object: typed(observedAt, "dateTime") },
    { subject: accountUri, predicate: RDF_TYPE, object: `${SCHEMA}Person` },
    { subject: accountUri, predicate: `${SCHEMA}identifier`, object: lit(`@${accountName}`) },
  ];
  if (post.created_at) raw.push({ subject: postUri, predicate: `${SCHEMA}datePublished`, object: lit(post.created_at) });

  const derived = [
    { subject: analysisUri, predicate: RDF_TYPE, object: `${NS}Classification` },
    { subject: analysisUri, predicate: `${SCHEMA}about`, object: postUri },
    { subject: analysisUri, predicate: `${NS}category`, object: lit(classification.category) },
    { subject: analysisUri, predicate: `${NS}confidence`, object: typed(classification.confidence, "decimal") },
    { subject: analysisUri, predicate: `${NS}evidenceLevel`, object: lit(classification.evidenceLevel) },
    { subject: analysisUri, predicate: `${NS}sourceTier`, object: lit(classification.sourceTier || "discovery") },
    { subject: analysisUri, predicate: `${NS}score`, object: typed(classification.score || 0, "integer") },
    { subject: analysisUri, predicate: `${NS}derivedAt`, object: typed(observedAt, "dateTime") },
  ];
  if (classification.searchTier) derived.push({ subject: analysisUri, predicate: `${NS}searchTier`, object: typed(classification.searchTier, "integer") });
  for (const item of classification.evidence) derived.push({ subject: analysisUri, predicate: `${NS}evidence`, object: lit(item) });
  for (const handle of classification.relationships.mentions) {
    derived.push({ subject: postUri, predicate: `${SCHEMA}mentions`, object: `https://x.com/${encodeURIComponent(normalizeHandle(handle))}` });
  }
  for (const hashtag of classification.relationships.hashtags) {
    derived.push({ subject: postUri, predicate: `${NS}hashtag`, object: lit(hashtag) });
  }
  for (const link of classification.relationships.links) {
    derived.push({ subject: postUri, predicate: `${SCHEMA}citation`, object: link });
  }
  return { raw: { name: rawName, quads: raw }, derived: { name: insightName, quads: derived }, postUri, analysisUri };
}

export function matchesDerivedQuads(body, expected) {
  const bindings = body?.result?.type === "bindings" ? body.result.bindings : null;
  if (!Array.isArray(bindings) || bindings.length === 0 || bindings.length > 100 || expected.length > 100) return false;
  // Oxigraph drops trailing zeros in xsd:dateTime fractions: 11.380Z comes back 11.38Z.
  const canonicalDateTime = (value) => {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
    if (!match) return value;
    const fraction = match[2]?.replace(/0+$/, "");
    return `${match[1]}${fraction ? `.${fraction}` : ""}${match[3]}`;
  };
  const literalKey = (datatype, lexical) => {
    const type = datatype === `${XSD}string` ? "" : datatype || "";
    return `literal:${type}:${type === `${XSD}dateTime` ? canonicalDateTime(lexical) : lexical}`;
  };
  const expectedTerm = (value) => {
    if (typeof value !== "string") return null;
    if (!value.startsWith('"')) return /^https?:\/\/[^\s<>"\\]+$/.test(value) ? `uri:${value}` : null;
    const match = /^("(?:\\.|[^"\\])*")(?:\^\^<([^>]+)>)?$/.exec(value);
    if (!match || match[2] && !/^https?:\/\/[^\s<>"\\]+$/.test(match[2])) return null;
    try { return literalKey(match[2], JSON.parse(match[1])); }
    catch { return null; }
  };
  const term = (value) => {
    if (typeof value === "string") return expectedTerm(value);
    if (!value || typeof value !== "object" || typeof value.value !== "string") return null;
    if (value.type === "uri") {
      if (value.datatype !== undefined || value["xml:lang"] !== undefined || value.lang !== undefined) return null;
      const normalized = expectedTerm(value.value);
      return normalized?.startsWith("uri:") ? normalized : null;
    }
    if (value.type !== "literal" && value.type !== "typed-literal") return null;
    if (value["xml:lang"] !== undefined || value.lang !== undefined || value.type === "typed-literal" && !value.datatype
      || value.datatype !== undefined && (typeof value.datatype !== "string" || !/^https?:\/\/[^\s<>"\\]+$/.test(value.datatype))) return null;
    return literalKey(value.datatype, value.value);
  };
  const key = (subject, predicate, object) => JSON.stringify([subject, predicate, object]);
  const wanted = new Set(expected.map(({ subject, predicate, object }) => key(`uri:${subject}`, `uri:${predicate}`, expectedTerm(object))));
  if (wanted.size !== expected.length || bindings.length !== wanted.size || expected.some(({ object }) => expectedTerm(object) === null)) return false;
  const seen = new Set();
  for (const row of bindings) {
    const value = key(term(row?.s), term(row?.p), term(row?.o));
    if (!wanted.has(value) || seen.has(value)) return false;
    seen.add(value);
  }
  return seen.size === wanted.size;
}

export function openStore(dbPath, legacySeenPath, detectionsPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS observations (
      post_id TEXT PRIMARY KEY,
      account TEXT NOT NULL,
      kind TEXT NOT NULL,
      post_url TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT,
      is_reply INTEGER NOT NULL DEFAULT 0,
       is_rt INTEGER NOT NULL DEFAULT 0,
       author_verified INTEGER NOT NULL DEFAULT 0,
       observed_at TEXT NOT NULL,
      classification_json TEXT NOT NULL,
      raw_asset TEXT,
      insight_asset TEXT
    );
    CREATE TABLE IF NOT EXISTS deliveries (
      post_id TEXT NOT NULL REFERENCES observations(post_id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0,
      next_attempt_at TEXT NOT NULL,
      last_error TEXT,
      completed_at TEXT,
      PRIMARY KEY (post_id, stage)
    );
    CREATE TABLE IF NOT EXISTS seeded_accounts (
      account TEXT PRIMARY KEY,
      seeded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seeded_account_activity (
      account TEXT PRIMARY KEY,
      seeded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS seeded_searches (
      search_key TEXT PRIMARY KEY,
      seeded_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS account_users (
      account TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      refreshed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS runtime_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      refreshed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS deliveries_due ON deliveries(status, next_attempt_at);
  `);

  if (!db.prepare("PRAGMA table_info(observations)").all().some((column) => column.name === "author_verified")) {
    db.exec("ALTER TABLE observations ADD COLUMN author_verified INTEGER NOT NULL DEFAULT 0");
  }
  const count = db.prepare("SELECT COUNT(*) AS count FROM observations").get().count;
  if (count === 0 && fs.existsSync(legacySeenPath)) {
    const insertObservation = db.prepare(`INSERT OR IGNORE INTO observations
      (post_id, account, kind, post_url, summary, created_at, observed_at, classification_json)
      VALUES (?, ?, ?, ?, '', '', ?, '{}')`);
    const insertDelivery = db.prepare(`INSERT OR IGNORE INTO deliveries
      (post_id, stage, status, next_attempt_at, completed_at) VALUES (?, ?, 'skipped', ?, ?)`);
    try {
      const legacy = JSON.parse(fs.readFileSync(legacySeenPath, "utf8"));
      for (const [id, item] of Object.entries(legacy.ids || {})) {
        const at = item.at || now();
        const account = item.account || "";
        insertObservation.run(id, account, item.kind || "legacy", `https://x.com/${normalizeHandle(account)}/status/${id}`, at);
        for (const stage of ["raw-dkg", "derived-dkg", "webhook"]) insertDelivery.run(id, stage, at, at);
      }
      const seed = db.prepare("INSERT OR IGNORE INTO seeded_accounts (account, seeded_at) VALUES (?, ?)");
      for (const account of Object.keys(legacy.seededAccounts || {})) seed.run(account.toLowerCase(), now());
    } catch {}
  }

  // Recover DKG writes known to have failed before durable queue existed. Webhooks already succeeded.
  if (fs.existsSync(detectionsPath)) {
    const updateObservation = db.prepare(`UPDATE observations SET summary = ?, post_url = ?, kind = ?, classification_json = ? WHERE post_id = ?`);
    const retry = db.prepare(`UPDATE deliveries SET status = 'pending', next_attempt_at = ?, completed_at = NULL
      WHERE post_id = ? AND stage IN ('raw-dkg', 'derived-dkg') AND status = 'skipped'`);
    try {
      for (const line of fs.readFileSync(detectionsPath, "utf8").split(/\r?\n/).filter(Boolean)) {
        const row = JSON.parse(line);
        if (!row.swmOk || !row.post_id) {
          const post = { post_id: row.post_id, account: row.account, summary: row.summary };
          const classification = classifyPost(post, ["origin_trail", "umanitek", "BranaRakic"]);
          updateObservation.run(row.summary || "", row.post_url || "", row.action === "amplify_official" ? "support" : "official", JSON.stringify(classification), row.post_id);
          retry.run(now(), row.post_id);
        }
      }
    } catch {}
  }
  db.exec(`UPDATE observations SET
    raw_asset = COALESCE(raw_asset, 'raw-x-post-' || post_id),
    insight_asset = COALESCE(insight_asset, 'x-insight-' || post_id)`);
  db.exec(`UPDATE deliveries SET status = 'skipped', completed_at = datetime('now'), last_error = 'retired webhook'
    WHERE stage = 'webhook' AND status = 'pending'`);
  db.exec(`UPDATE deliveries SET status = 'skipped', completed_at = datetime('now'), last_error = 'legacy push not verified'
    WHERE stage = 'collective-push-dkg' AND status = 'pending'`);
  db.prepare(`UPDATE deliveries SET status = 'quarantined', completed_at = NULL,
    last_error = substr(COALESCE(last_error, 'retry limit reached') || '; manual DKG lifecycle review required (no automatic SWM share)', 1, 1000)
    WHERE stage IN ('raw-dkg', 'derived-dkg') AND status = 'pending'
      AND (attempts >= ? OR lower(COALESCE(last_error, '')) LIKE '%unfinished promote%'
         OR lower(COALESCE(last_error, '')) LIKE '%not readable as sealed%')`).run(MAX_DKG_ATTEMPTS);
  return db;
}

export function createWatcher({ fanout, log = console, getAdditionalAccounts = () => [] }) {
  const accounts = uniqueHandles(OFFICIAL_ACCOUNTS);
  const trustedAccounts = [...TRUSTED_PUSH_ACCOUNTS];
  const configuredSupportAccounts = uniqueHandles(
    (process.env.WATCH_SUPPORT_ACCOUNTS || "CredibleCrypto").split(",").map(normalizeHandle).filter(Boolean),
  );
  const defaultSearches = [
    '"OriginTrail" OR "$TRAC" OR "@origin_trail" OR "Umanitek"',
    '"decentralized knowledge graph" OR "OriginTrail DKG" OR "DKG V10" OR "Verifiable Internet for AI" OR "NeuroWeb" OR "ChatDKG"',
    '("OriginTrail" OR "$TRAC" OR "Umanitek" OR "NeuroWeb") ("knowledge asset" OR "paranet" OR "knowledge mining" OR "trusted AI" OR "verifiable AI")',
    '("OriginTrail" OR "$TRAC" OR "Umanitek") ("GS1" OR "SCAN" OR "SBB" OR "provenance" OR "supply chain" OR "digital product passport" OR "staking" OR "network revenue")',
  ];
  let searchQueries = defaultSearches;
  if (process.env.WATCH_SEARCH_QUERIES_JSON) {
    try {
      const configured = JSON.parse(process.env.WATCH_SEARCH_QUERIES_JSON);
      if (Array.isArray(configured) && configured.every((item) => typeof item === "string" && item.trim())) searchQueries = configured;
    } catch (error) { log.error?.("watcher search config", String(error.message || error)); }
  }
  const pollMs = Number(process.env.WATCH_POLL_MS || 60000);
  const searchEvery = Math.max(1, Number(process.env.WATCH_SEARCH_EVERY || 2));
  const retryMs = Number(process.env.WATCH_RETRY_MS || 30000);
  const reconcileMs = Number(process.env.WATCH_DKG_RECONCILE_MS || 300000);
  const skipRts = process.env.WATCH_SKIP_RTS !== "0";
  const skipReplies = process.env.WATCH_SKIP_REPLIES !== "0";
  const seenPath = process.env.WATCH_SEEN || "/root/dkg-swarm-webhooks/data/seen.json";
  const dbPath = process.env.WATCH_DB || "/root/dkg-swarm-webhooks/data/watcher.sqlite";
  const detectionsPath = process.env.WATCH_DETECTIONS || "/root/dkg-swarm-webhooks/data/detections.jsonl";
  const graphId = process.env.DKG_PUBLIC_GRAPH_ID || "trac-marketing";
  const xApiBearer = String(process.env.WATCH_X_API_BEARER || "").trim();
  const xApiReady = Boolean(xApiBearer);
  const searchReady = xApiReady;
  const dkgApi = (process.env.DKG_API_URL || "http://127.0.0.1:9200").replace(/\/$/, "");
  const db = openStore(dbPath, seenPath, detectionsPath);
  const state = {
    lastPoll: null, lastError: null, lastDkgReconcile: null,
    lastSearch: null, cooldownUntil: null, pollCount: 0, searchCursor: 0,
    detections: [], running: false, queueRunning: false, reconcileRunning: false,
  };

  function supportAccounts() {
    let additional = [];
    try { additional = getAdditionalAccounts() || []; }
    catch (error) { log.error?.("watcher registered accounts", String(error.message || error)); }
    return uniqueHandles([
      ...configuredSupportAccounts,
      ...additional.map(normalizeHandle).filter(Boolean),
    ]);
  }

  function monitoredAccounts() {
    return uniqueHandles([...accounts, ...trustedAccounts, ...supportAccounts()]);
  }

  function sourceTier(screen) {
    const key = normalizeHandle(screen).toLowerCase();
    if (accounts.some((item) => item.toLowerCase() === key)) return "official";
    if (trustedAccounts.some((item) => item.toLowerCase() === key)) return "approved-writer";
    const registered = (() => {
      try { return (getAdditionalAccounts() || []).map(normalizeHandle).filter(Boolean); }
      catch { return []; }
    })();
    if (registered.some((item) => item.toLowerCase() === key)) return "swarm-member";
    return "ecosystem-account";
  }

  function rememberDetection(row) {
    state.detections.unshift(row);
    state.detections = state.detections.slice(0, 40);
    try { fs.appendFileSync(detectionsPath, `${JSON.stringify(row)}\n`); } catch {}
  }

  async function xApi(pathname, params = {}) {
    const url = new URL(`${X_API_BASE}${pathname}`);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${xApiBearer}`, "User-Agent": "dkgswarm-collector" },
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) {
      const error = new Error(`X API ${response.status}`);
      error.status = response.status;
      const retryAfter = Number(response.headers.get("retry-after") || 0);
      const resetAt = Number(response.headers.get("x-rate-limit-reset") || 0) * 1000;
      error.retryAt = retryAfter ? Date.now() + retryAfter * 1000 : resetAt || 0;
      throw error;
    }
    return response.json();
  }

  async function userId(screen) {
    const key = screen.toLowerCase();
    const cached = db.prepare("SELECT user_id, refreshed_at FROM account_users WHERE account = ?").get(key);
    if (cached && Date.parse(cached.refreshed_at) > Date.now() - 7 * 24 * 3600000) return cached.user_id;
    const data = await xApi(`/users/by/username/${encodeURIComponent(screen)}`);
    const id = data?.data?.id;
    if (!id) throw new Error(`no user id for ${screen}`);
    db.prepare(`INSERT INTO account_users (account, user_id, refreshed_at) VALUES (?, ?, ?)
      ON CONFLICT(account) DO UPDATE SET user_id = excluded.user_id, refreshed_at = excluded.refreshed_at`).run(key, id, now());
    return id;
  }

  async function fetchAccount(screen) {
    const uid = await userId(screen);
    const trusted = trustedAccounts.some((account) => account.toLowerCase() === screen.toLowerCase());
    const posts = new Map();
    const tokens = new Set();
    const cutoff = Date.now() - PUSH_WINDOW_MS - 2 * 60000;
    let token = "";
    for (let page = 0; page < (trusted ? 3 : 1); page++) {
      const data = await xApi(`/users/${encodeURIComponent(uid)}/tweets`, {
        max_results: 12,
        pagination_token: token,
        "tweet.fields": X_TWEET_FIELDS,
        expansions: "author_id",
        "user.fields": "username",
      });
      const pagePosts = postsFromXApi(data, { userId: uid, screen });
      const newPosts = pagePosts.filter((post) => !posts.has(post.post_id));
      for (const post of newPosts) posts.set(post.post_id, post);
      if (!trusted || !newPosts.length) break;
      const timestamps = pagePosts.map((post) => Date.parse(post.created_at));
      if (timestamps.length && timestamps.every((timestamp) => Number.isFinite(timestamp) && timestamp < cutoff)) break;
      const next = data?.meta?.next_token;
      if (!next || tokens.has(next)) break;
      tokens.add(next);
      token = next;
    }
    return [...posts.values()];
  }

  async function fetchSearch(rawQuery) {
    const data = await xApi("/tweets/search/recent", {
      query: rawQuery,
      max_results: 20,
      "tweet.fields": X_TWEET_FIELDS,
      expansions: "author_id",
      "user.fields": "username",
    });
    return postsFromXApi(data);
  }

  function persist(post, kind, classification, queue = true, trustedSource = false) {
    const observedAt = now();
    const assets = buildAssets(post, classification, observedAt);
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = db.prepare(`INSERT OR IGNORE INTO observations
         (post_id, account, kind, post_url, summary, created_at, is_reply, is_rt, author_verified, observed_at, classification_json, raw_asset, insight_asset)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
         .run(post.post_id, post.account, kind, post.post_url, post.summary, post.created_at || "", post.isReply ? 1 : 0, post.isRt ? 1 : 0, post.authorVerified ? 1 : 0, observedAt, JSON.stringify(classification), assets.raw.name, assets.derived.name);
      const old = result.changes ? null : db.prepare("SELECT classification_json FROM observations WHERE post_id = ?").get(post.post_id);
      const current = old ? JSON.parse(old.classification_json) : null;
      const priority = { official: 4, "approved-writer": 3, "swarm-member": 2, "ecosystem-account": 1, discovery: 0 };
      const upgrade = current && (priority[classification.sourceTier] ?? 0) > (priority[current.sourceTier] ?? 0);
       if (upgrade || (trustedSource && post.authorVerified)) db.prepare(`UPDATE observations SET account = ?, kind = ?, post_url = ?, summary = ?, created_at = ?,
         is_reply = ?, is_rt = ?, author_verified = ?, classification_json = ? WHERE post_id = ?`).run(post.account, kind, post.post_url, post.summary,
         post.created_at || "", post.isReply ? 1 : 0, post.isRt ? 1 : 0, post.authorVerified ? 1 : 0, JSON.stringify(classification), post.post_id);
       if (trustedSource && trustedPushEligible(post)) {
         db.prepare("INSERT OR IGNORE INTO deliveries (post_id, stage, next_attempt_at) VALUES (?, 'trusted-push-dkg', ?)")
           .run(post.post_id, observedAt);
       }
       if (queue && (result.changes || upgrade)) {
        const insert = db.prepare("INSERT OR IGNORE INTO deliveries (post_id, stage, next_attempt_at) VALUES (?, ?, ?)");
        for (const stage of ["raw-dkg", "derived-dkg"]) insert.run(post.post_id, stage, observedAt);
        if (upgrade) db.prepare(`UPDATE deliveries SET status = 'pending', next_attempt_at = ?, completed_at = NULL
          WHERE post_id = ? AND stage = 'derived-dkg' AND status = 'skipped'`).run(observedAt, post.post_id);
      }
      db.exec("COMMIT");
      return result.changes > 0 || Boolean(upgrade);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  async function writeAsset(asset) {
    const token = loadToken();
    if (!token) throw new Error("no dkg token");
    const response = await fetch(`${dkgApi}/api/knowledge-assets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contextGraphId: graphId, name: asset.name, quads: asset.quads, finalize: false, alsoShareSwm: false }),
      signal: AbortSignal.timeout(20000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
       if ((response.status === 409 || /not an active Working Memory draft/i.test(body.error || body.message || ""))
         && asset.name.startsWith("collective-push-x-")) {
         if (await assetIsShared(asset.name)) return { status: "swm-shared", recovered: true };
         if (await assetExistsInWorkingMemory(asset.name)) return { status: "wm-draft", recovered: true };
       }
      throw new Error(`DKG ${response.status}: ${body.error || body.message || "asset write failed"}`);
    }
    if (!isWorkingAsset(body) && !isSharedAsset(body)) throw new Error(`DKG asset ${asset.name} write not confirmed`);
    if (asset.name.startsWith("collective-push-x-") && !await assetExistsInWorkingMemory(asset.name) && !await assetIsShared(asset.name)) {
      throw new Error(`DKG asset ${asset.name} has no queryable WM content`);
    }
    return body;
  }

  async function assetExistsInView(name, view) {
    const identity = assetIdentity(name);
    if (!identity) throw new Error(`unknown DKG asset ${name}`);
    const token = loadToken();
    if (!token) throw new Error("no dkg token");
    const url = new URL(`${dkgApi}/api/knowledge-assets/${encodeURIComponent(name)}`);
    url.searchParams.set("contextGraphId", graphId);
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
    if (response.status === 404) return false;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(`DKG ${response.status}: ${body.error || body.message || "asset lookup failed"}`);
    }

    const query = await fetch(`${dkgApi}/api/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        contextGraphId: graphId,
        view,
        sparql: `ASK { <${identity.subject}> <${RDF_TYPE}> <${identity.type}> }`,
      }),
      signal: AbortSignal.timeout(12000),
    });
    const queryBody = await query.json().catch(() => ({}));
    if (!query.ok) throw new Error(`DKG ${query.status}: ${queryBody.error || queryBody.message || "asset content lookup failed"}`);
    return hasQueryContent(queryBody);
  }

  const assetIsShared = (name) => assetExistsInView(name, "shared-working-memory");
  const assetExistsInWorkingMemory = (name) => assetExistsInView(name, "working-memory");

   async function assetContentMatches(postId, stage) {
     if (stage !== "raw-dkg" && stage !== "derived-dkg") return false;
     const data = queuedPost(postId);
     if (!data || !/^\d+$/.test(String(data.post.post_id))) return false;
     let expected;
     try { expected = buildAssets(data.post, data.classification, data.observedAt)[stage === "raw-dkg" ? "raw" : "derived"].quads; }
     catch { return false; }
     return expectedQuadsMatch(expected, ["working-memory", "shared-working-memory"]);
   }

   /** true when a view holds exactly `expected` for its subjects, false when not, null when unverifiable. */
   async function expectedQuadsMatch(expected, views) {
      // Full rdf:type IRI inside VALUES is rejected by the scoped-query rewriter
      // ("unable to locate a graph-scopable WHERE block"). Prefixed rdf:type is accepted.
      const pairs = [...new Set(expected.map(({ subject, predicate }) =>
        `<${subject}> ${predicate === RDF_TYPE ? "rdf:type" : `<${predicate}>`}`))];
      if (!pairs.length || expected.length > 100 || pairs.some((pair) => !/^<https?:\/\/[^<>\s]+> (?:rdf:type|<https?:\/\/[^<>\s]+>)$/.test(pair))) return false;
      const token = loadToken();
       if (!token) return null;
       let unavailable = false;
      for (const view of views) {
        try {
          const response = await fetch(`${dkgApi}/api/query`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ contextGraphId: graphId, view,
              sparql: `PREFIX rdf: <${RDF_TYPE.slice(0, RDF_TYPE.lastIndexOf("#") + 1)}> SELECT DISTINCT ?s ?p ?o WHERE { VALUES (?s ?p) { ${pairs.map((pair) => `(${pair})`).join(" ")} } ?s ?p ?o } LIMIT 101` }),
           signal: AbortSignal.timeout(12000),
         });
          if (!response.ok) { unavailable = true; continue; }
          const body = await response.json();
          if (body?.result?.type !== "bindings" || !Array.isArray(body.result.bindings)) { unavailable = true; continue; }
          if (matchesDerivedQuads(body, expected)) return true;
        } catch { unavailable = true; }
      }
      return unavailable ? null : false;
   }

  async function reconcileDkgDeliveries() {
    if (state.reconcileRunning) return;
    state.reconcileRunning = true;
    try {
      const saved = db.prepare("SELECT value FROM runtime_metadata WHERE key = 'dkg-reconcile-cursor-v2'").get()?.value;
      let cursor = saved ? JSON.parse(saved) : ["", "", ""];
      const completed = db.prepare(`SELECT post_id, stage, completed_at FROM deliveries
        WHERE status = 'completed' AND stage IN ('raw-dkg', 'derived-dkg')
          AND (COALESCE(completed_at, ''), post_id, stage) > (?, ?, ?)
        ORDER BY COALESCE(completed_at, ''), post_id, stage LIMIT 40`).all(...cursor);
      for (const row of completed) {
        const matches = await assetContentMatches(row.post_id, row.stage);
        if (matches === null) break;
        if (!matches) {
          db.prepare(`UPDATE deliveries SET status = 'pending', next_attempt_at = ?, completed_at = NULL,
            last_error = 'content mismatch during exact reconciliation' WHERE post_id = ? AND stage = ? AND status = 'completed'`)
            .run(now(), row.post_id, row.stage);
        }
        cursor = [row.completed_at || "", row.post_id, row.stage];
        db.prepare(`INSERT INTO runtime_metadata (key, value, refreshed_at) VALUES ('dkg-reconcile-cursor-v2', ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, refreshed_at = excluded.refreshed_at`).run(JSON.stringify(cursor), now());
      }
      if (!completed.length) db.prepare("DELETE FROM runtime_metadata WHERE key = 'dkg-reconcile-cursor-v2'").run();
      const candidates = db.prepare(`SELECT d.post_id, d.stage FROM deliveries d
        WHERE d.stage IN ('raw-dkg', 'derived-dkg') AND d.status = 'quarantined'
          AND (d.last_error LIKE '%WM/SWM content not exactly verified%'
            OR d.last_error LIKE '%not an active Working Memory draft%')
        ORDER BY d.next_attempt_at LIMIT 40`).all();
      for (const { post_id, stage } of candidates) {
        if (await assetContentMatches(post_id, stage)) {
          db.prepare(`UPDATE deliveries SET status = 'completed', completed_at = ?, last_error = NULL
            WHERE post_id = ? AND stage = ? AND status = 'quarantined'`).run(now(), post_id, stage);
          continue;
        }
        db.prepare(`UPDATE deliveries SET next_attempt_at = ? WHERE post_id = ? AND stage = ? AND status = 'quarantined'`)
          .run(new Date(Date.now() + reconcileMs).toISOString(), post_id, stage);
      }
      state.lastDkgReconcile = now();
    } catch (error) {
      log.error?.("watcher reconciliation", String(error.message || error));
    } finally {
      state.reconcileRunning = false;
    }
  }

  function announcementAngle(post, kind) {
    const excerpt = post.summary.slice(0, 180);
    return kind === "support" ? `Support ${post.account} on $TRAC: ${excerpt}` : `Amplify official ${post.account} announcement: ${excerpt}`;
  }

  function queuedPost(id) {
    const row = db.prepare("SELECT * FROM observations WHERE post_id = ?").get(id);
    if (!row) return null;
    return {
       post: { post_id: row.post_id, account: row.account, post_url: row.post_url, summary: row.summary, created_at: row.created_at, isReply: !!row.is_reply, isRt: !!row.is_rt, authorVerified: !!row.author_verified },
      kind: row.kind,
      classification: JSON.parse(row.classification_json || "{}"),
      observedAt: row.observed_at,
    };
  }

  async function trustedPushShared(push) {
    const token = loadToken();
    if (!token) throw new Error("no dkg token");
    const response = await fetch(`${dkgApi}/api/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contextGraphId: graphId, view: "shared-working-memory",
        sparql: `ASK { <${push.subject}> <${CURATOR_NS}targetPost> <${push.target}> }` }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error(`DKG shared push lookup ${response.status}`);
    return hasQueryContent(await response.json());
  }

  async function publishTrustedPush(post) {
    const push = buildTrustedPush(post);
    if (await trustedPushShared(push)) return;
    if (!trustedPushEligible(post)) return;
    if (!await assetExistsInWorkingMemory(push.name)) {
      try { await writeAsset(push); }
      catch (error) {
        if (!await trustedPushShared(push) && !await assetExistsInWorkingMemory(push.name)) throw error;
      }
    }
    if (await trustedPushShared(push)) return;
    const token = loadToken();
    if (!token) throw new Error("no dkg token");
    if (!trustedPushEligible(post)) return;
    // Never share a Working Memory subject by name alone: it must hold exactly the watcher-authored quads.
    if (await expectedQuadsMatch(push.quads, ["working-memory"]) !== true) {
      throw new Error(`collective push ${push.name} WM content is not the watcher-authored draft; not sharing`);
    }
    const response = await fetch(`${dkgApi}/api/knowledge-assets/${push.name}/swm/share`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ contextGraphId: graphId }), signal: AbortSignal.timeout(20000),
    });
    if (!await trustedPushShared(push)) throw new Error(`DKG push share not queryable (${response.status})`);
  }

  function quarantineDelivery(id, stage, attempts, reason) {
    db.prepare(`UPDATE deliveries SET status = 'quarantined', attempts = ?, completed_at = NULL, last_error = ?
      WHERE post_id = ? AND stage = ?`).run(attempts, String(reason).slice(0, 1000), id, stage);
  }

  function retryDelivery(id, stage, attempts, error) {
    const reason = String(error);
    if ((stage === 'raw-dkg' || stage === 'derived-dkg') &&
      (attempts >= MAX_DKG_ATTEMPTS || /unfinished promote|not readable as sealed/i.test(reason))) {
      quarantineDelivery(id, stage, attempts, `${reason}; manual DKG lifecycle review required (no automatic SWM share)`);
      return;
    }
    const delay = Math.min(3600000, 15000 * 2 ** Math.min(attempts, 8));
    db.prepare(`UPDATE deliveries SET status = 'pending', attempts = ?, next_attempt_at = ?, last_error = ? WHERE post_id = ? AND stage = ?`)
      .run(attempts, new Date(Date.now() + delay).toISOString(), reason.slice(0, 1000), id, stage);
  }

  function deferVerification(job) {
    db.prepare(`UPDATE deliveries SET next_attempt_at = ?, last_error = 'verification unavailable; mutation deferred'
      WHERE post_id = ? AND stage = ? AND status = 'pending'`)
      .run(new Date(Date.now() + retryMs).toISOString(), job.post_id, job.stage);
  }

  function completeDelivery(id, stage) {
    db.prepare("UPDATE deliveries SET status = 'completed', completed_at = ?, last_error = NULL WHERE post_id = ? AND stage = ?").run(now(), id, stage);
  }

  async function processQueue() {
    if (state.queueRunning) return;
    state.queueRunning = true;
    try {
      const due = db.prepare("SELECT * FROM deliveries WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY CASE WHEN stage = 'trusted-push-dkg' THEN 0 ELSE 1 END, next_attempt_at LIMIT 30").all(now());
      for (const job of due) {
        const data = queuedPost(job.post_id);
        if (!data) continue;
         const assets = buildAssets(data.post, data.classification, data.observedAt);
         if (job.stage === "trusted-push-dkg" && !trustedPushEligible(data.post)) {
           db.prepare("UPDATE deliveries SET status = 'skipped', completed_at = ?, last_error = 'expired or unverified source' WHERE post_id = ? AND stage = ?")
             .run(now(), job.post_id, job.stage);
           continue;
         }
         try {
          let outcome;
           if (job.stage === "raw-dkg" || job.stage === "derived-dkg") {
             const matches = await assetContentMatches(job.post_id, job.stage);
             if (matches === null) { deferVerification(job); continue; }
             if (matches) {
               completeDelivery(job.post_id, job.stage);
               continue;
             }
             outcome = await writeAsset(job.stage === "raw-dkg" ? assets.raw : assets.derived);
             const confirmed = await assetContentMatches(job.post_id, job.stage);
             if (confirmed === null) { deferVerification(job); continue; }
             if (!confirmed) throw new Error(`${job.stage} WM/SWM content not exactly verified`);
           }
           if (job.stage === "trusted-push-dkg") outcome = await publishTrustedPush(data.post);
           if (job.stage === "collective-push-dkg" || job.stage === "webhook") {
            db.prepare("UPDATE deliveries SET status = 'skipped', completed_at = ? WHERE post_id = ? AND stage = ?").run(now(), job.post_id, job.stage);
            continue;
          }
          completeDelivery(job.post_id, job.stage);
          log.info?.("watcher delivery", job.post_id, job.stage, "ok", outcome?.sent ?? "");
        } catch (error) {
          retryDelivery(job.post_id, job.stage, job.attempts + 1, error.message || error);
          log.error?.("watcher delivery", job.post_id, job.stage, String(error.message || error));
        }
      }
    } finally { state.queueRunning = false; }
  }

  async function poll() {
    if (state.running) return;
    if (state.cooldownUntil && Date.parse(state.cooldownUntil) > Date.now()) return;
    state.running = true;
    const errors = [];
    try {
      if (!xApiReady) {
        // Off by default: no official X API credential configured. DKG delivery still runs below.
        state.lastError = "X collection disabled: set WATCH_X_API_BEARER (official X API v2 app-only token)";
        return;
      }
      const currentSupport = supportAccounts();
      const supportKeys = new Set(currentSupport.map((item) => item.toLowerCase()));
      const officialKeys = new Set(accounts.map((item) => item.toLowerCase()));
      for (const screen of uniqueHandles([...accounts, ...trustedAccounts, ...currentSupport])) {
        try {
          const key = screen.toLowerCase();
          const kind = supportKeys.has(key) && !officialKeys.has(key) ? "support" : "official";
          const posts = await fetchAccount(screen);
          const seeded = db.prepare("SELECT 1 FROM seeded_accounts WHERE account = ?").get(screen.toLowerCase());
          const tier = sourceTier(screen);
          const collectsAll = tier === "approved-writer" || tier === "swarm-member";
          const activitySeeded = !collectsAll || db.prepare("SELECT 1 FROM seeded_account_activity WHERE account = ?").get(screen.toLowerCase());
          for (const post of posts) {
            if (shouldSkipPost(post, tier, skipReplies, skipRts)) continue;
            const classification = classifyPost(post, accounts, { sourceTier: tier });
            const historicalExpandedActivity = collectsAll && (post.isReply || post.isRt) && !activitySeeded;
           const queue = Boolean(seeded && classification.relevant && !historicalExpandedActivity);
           persist(post, kind, classification, queue, trustedAccounts.some((item) => item.toLowerCase() === key));
          }
          db.prepare("INSERT OR IGNORE INTO seeded_accounts (account, seeded_at) VALUES (?, ?)").run(screen.toLowerCase(), now());
          if (collectsAll) db.prepare("INSERT OR IGNORE INTO seeded_account_activity (account, seeded_at) VALUES (?, ?)").run(screen.toLowerCase(), now());
        } catch (error) {
          errors.push(`${screen}: ${error.message || error}`);
          if (error.status === 429 || error.status === 403) {
            const retryAt = Math.max(error.retryAt || 0, Date.now() + (error.status === 429 ? 15 : 60) * 60000);
            state.cooldownUntil = new Date(retryAt).toISOString();
          }
          log.error?.("watcher account", screen, String(error.message || error));
        }
      }
      state.pollCount += 1;
      if (searchReady && searchQueries.length && state.pollCount % searchEvery === 0 && (!state.cooldownUntil || Date.parse(state.cooldownUntil) <= Date.now())) {
        const searchTier = state.searchCursor % searchQueries.length + 1;
        const rawQuery = searchQueries[searchTier - 1];
        try {
          const posts = await fetchSearch(rawQuery);
          const seeded = db.prepare("SELECT 1 FROM seeded_searches WHERE search_key = ?").get(rawQuery);
          for (const post of posts) {
            if (shouldSkipPost(post, "discovery", skipReplies, skipRts)) continue;
            const classification = classifyPost(post, accounts, { sourceTier: "discovery", searchTier });
            persist(post, `search-tier-${searchTier}`, classification, Boolean(seeded && classification.relevant));
          }
          db.prepare("INSERT OR IGNORE INTO seeded_searches (search_key, seeded_at) VALUES (?, ?)").run(rawQuery, now());
          state.searchCursor = searchTier % searchQueries.length;
          state.lastSearch = now();
        } catch (error) {
          errors.push(`search tier ${searchTier}: ${error.message || error}`);
          if (error.status === 429 || error.status === 403) {
            const retryAt = Math.max(error.retryAt || 0, Date.now() + (error.status === 429 ? 15 : 60) * 60000);
            state.cooldownUntil = new Date(retryAt).toISOString();
          }
          log.error?.("watcher search", searchTier, String(error.message || error));
        }
      }
      state.lastPoll = now();
      state.lastError = errors.join("; ") || null;
      const metadata = db.prepare(`INSERT INTO runtime_metadata (key, value, refreshed_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, refreshed_at = excluded.refreshed_at`);
      if (!errors.length) metadata.run("collector-last-successful-poll", state.lastPoll, state.lastPoll);
      if (state.lastSearch) metadata.run("collector-last-search", state.lastSearch, state.lastPoll);
      metadata.run("collector-search-enabled", String(searchReady && searchQueries.length > 0), state.lastPoll);
    } catch (error) {
      state.lastError = String(error.message || error);
      log.error?.("watcher poll", state.lastError);
    } finally {
      state.running = false;
      await processQueue();
    }
  }

  const timers = [];
  return {
    processQueue,
    reconcileDkgDeliveries,
    stop() { for (const timer of timers.splice(0)) clearInterval(timer); },
    close() { for (const timer of timers.splice(0)) clearInterval(timer); db.close(); },
    start() {
      poll();
      reconcileDkgDeliveries().then(processQueue);
      timers.push(setInterval(poll, pollMs).unref());
      timers.push(setInterval(processQueue, retryMs).unref());
      timers.push(setInterval(() => reconcileDkgDeliveries().then(processQueue), reconcileMs).unref());
      log.info?.(`X watcher every ${pollMs}ms official=${accounts.join(",")} support=${supportAccounts().join(",")}`);
    },
    status() {
      const queue = db.prepare("SELECT stage, status, COUNT(*) AS count FROM deliveries GROUP BY stage, status").all();
      const retryingDkg = db.prepare(`SELECT COUNT(*) AS count FROM deliveries
        WHERE stage IN ('raw-dkg', 'derived-dkg') AND status = 'pending' AND attempts > 0`).get().count;
      const dkgFailures = db.prepare(`SELECT d.post_id, d.stage, d.attempts, d.last_error, o.raw_asset, o.insight_asset
        FROM deliveries d JOIN observations o ON o.post_id = d.post_id
        WHERE d.status = 'quarantined' AND d.stage IN ('raw-dkg', 'derived-dkg')
        ORDER BY d.attempts DESC`).all().map(({ post_id, stage, attempts, last_error, raw_asset, insight_asset }) => ({
          post_id, stage, attempts, last_error, asset: stage === 'raw-dkg' ? raw_asset : insight_asset,
        }));
      return {
        accounts, trustedAccounts, supportAccounts: supportAccounts(), monitoredAccounts: monitoredAccounts(), searchQueries, searchEvery, searchReady,
        pollMs, retryMs, reconcileMs, skipRts, skipReplies,
        lastPoll: state.lastPoll, lastSearch: state.lastSearch, lastError: state.lastError, cooldownUntil: state.cooldownUntil, lastDkgReconcile: state.lastDkgReconcile,
        seeded: db.prepare("SELECT COUNT(*) AS count FROM seeded_accounts").get().count > 0,
        seenCount: db.prepare("SELECT COUNT(*) AS count FROM observations").get().count,
        queue, retryingDkg, dkgFailures, detections: state.detections,
      };
    },
    async test(fields) {
      const post = {
        post_id: String(fields.post_id || Date.now()), account: fields.account || "@origin_trail",
        post_url: fields.post_url || "", summary: fields.summary || "admin test collective push",
        created_at: new Date().toUTCString(), isReply: false, isRt: false,
      };
      if (post.post_url && !fields.post_id) post.post_id = post.post_url.match(/status\/(\d+)/)?.[1] || post.post_id;
      if (!post.post_url) post.post_url = `https://x.com/${normalizeHandle(post.account)}/status/${post.post_id}`;
      const key = normalizeHandle(post.account).toLowerCase();
      const kind = supportAccounts().map((item) => item.toLowerCase()).includes(key)
        && !accounts.map((item) => item.toLowerCase()).includes(key) ? "support" : "official";
      const classification = classifyPost(post, accounts, { sourceTier: sourceTier(post.account) });
      const inserted = persist(post, kind, classification, classification.relevant);
      await processQueue();
      return { inserted, classification, post_id: post.post_id };
    },
  };
}
