// Fixed-window counters keyed by caller (IP, token family) plus one global key.
export function createWindowLimiter({ windowMs, max, maxKeys = 10000 }) {
  const buckets = new Map();
  return {
    take(key, now = Date.now()) {
      const bucket = buckets.get(key);
      const current = !bucket || bucket.until <= now ? { count: 0, until: now + windowMs } : bucket;
      if (current.count >= max) return false;
      current.count += 1;
      buckets.set(key, current);
      if (buckets.size > maxKeys) {
        for (const [k, v] of buckets) if (v.until <= now) buckets.delete(k);
      }
      return true;
    },
  };
}

// Express middleware: one per-caller and one global window; 429 when either is spent.
export function limitRequests({ perClient, global, keyOf = (req) => req.ip || "unknown" }) {
  return (req, res, next) => {
    if (!perClient.take(`client:${keyOf(req)}`) || !global.take("global")) {
      res.set("Retry-After", "60");
      res.status(429).json({ error: "too_many_requests", error_description: "Rate limit exceeded; retry later" });
      return;
    }
    next();
  };
}
