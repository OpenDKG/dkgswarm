// Fixed-window counters keyed by caller (IP, token family) plus one global key.
export function createWindowLimiter({ windowMs, max, maxKeys = 10000 }) {
  if (!Number.isSafeInteger(maxKeys) || maxKeys < 1) throw new RangeError("maxKeys must be a positive integer");
  const buckets = new Map();
  let expiresNext = Infinity;
  return {
    take(key, now = Date.now()) {
      const bucket = buckets.get(key);
      if (bucket && bucket.until > now) {
        if (bucket.count >= max) return false;
        bucket.count += 1;
        return true;
      }
      if (!bucket && buckets.size === maxKeys) {
        if (now < expiresNext) return false;
        expiresNext = Infinity;
        for (const [id, entry] of buckets) {
          if (entry.until <= now) buckets.delete(id);
          else expiresNext = Math.min(expiresNext, entry.until);
        }
        if (buckets.size === maxKeys) return false;
      }
      if (max < 1) return false;
      const until = now + windowMs;
      buckets.set(key, { count: 1, until });
      expiresNext = Math.min(expiresNext, until);
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
