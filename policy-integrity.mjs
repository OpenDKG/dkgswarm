import { createHash, timingSafeEqual } from "node:crypto";
import fs from "node:fs";

export const POLICY_PIN_CODES = Object.freeze({
  MISSING: "POLICY_PIN_MISSING",
  UNREADABLE: "POLICY_PIN_UNREADABLE",
  MALFORMED: "POLICY_PIN_MALFORMED",
  INCOMPLETE: "POLICY_PIN_INCOMPLETE",
  IDENTITY: "POLICY_PIN_IDENTITY_MISMATCH",
  INTEGRITY: "POLICY_PIN_INTEGRITY_MISMATCH",
  UNAVAILABLE: "POLICY_PIN_UNAVAILABLE",
});

export class PolicyPinError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "PolicyPinError";
    this.code = code;
  }
}

// The digest is pinned outside the graph. A graph writer cannot change trusted policy bytes.
export function policyDigest(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}

/** Validates a pin object without destructuring it first, so a missing pin is never a raw TypeError. */
export function validatePolicyPin(pin) {
  if (pin === null || typeof pin !== "object" || Array.isArray(pin)) {
    throw new PolicyPinError(POLICY_PIN_CODES.MISSING, "Owner policy integrity pin missing or invalid");
  }
  const { version, sha256, contextGraphId } = pin;
  if (!Number.isSafeInteger(version) || version < 1 || !/^[a-f0-9]{64}$/.test(sha256 || "")) {
    throw new PolicyPinError(POLICY_PIN_CODES.INCOMPLETE, "Owner policy integrity pin missing or invalid");
  }
  return { version, sha256, contextGraphId };
}

/** Reads and validates the pointer file, distinguishing missing, unreadable and malformed pins. */
export function readPolicyPin(pointerPath, readFile = (path) => fs.readFileSync(path, "utf8")) {
  let raw;
  try {
    raw = readFile(pointerPath);
  } catch (error) {
    const code = error?.code === "ENOENT" ? POLICY_PIN_CODES.MISSING : POLICY_PIN_CODES.UNREADABLE;
    throw new PolicyPinError(code, `Owner policy pin ${code === POLICY_PIN_CODES.MISSING ? "not found" : "unreadable"}: ${pointerPath}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PolicyPinError(POLICY_PIN_CODES.MALFORMED, `Owner policy pin malformed: ${pointerPath}`);
  }
  return validatePolicyPin(parsed);
}

/** Readiness view used by /health and /readyz; liveness stays separate. */
export function policyReadiness(pointerPath, readFile) {
  try {
    const pin = readPolicyPin(pointerPath, readFile);
    return { ready: true, version: pin.version };
  } catch (error) {
    return {
      ready: false,
      code: error instanceof PolicyPinError ? error.code : POLICY_PIN_CODES.INCOMPLETE,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function verifyPolicyBindings(bindings, pin) {
  const { version, sha256, contextGraphId } = validatePolicyPin(pin);
  if (!Array.isArray(bindings) || bindings.length !== 1 || typeof bindings[0]?.o !== "string") {
    throw new PolicyPinError(POLICY_PIN_CODES.UNAVAILABLE, "Owner policy unavailable or ambiguous in Shared Working Memory");
  }
  let policy;
  try { policy = JSON.parse(JSON.parse(bindings[0].o)); }
  catch { throw new PolicyPinError(POLICY_PIN_CODES.MALFORMED, "Owner policy malformed in Shared Working Memory"); }
  if (policy?.kind !== "swarm-coordination-policy" || policy.version !== version || policy.contextGraphId !== contextGraphId) {
    throw new PolicyPinError(POLICY_PIN_CODES.IDENTITY, "Owner policy identity mismatch");
  }
  const actual = Buffer.from(policyDigest(policy), "hex");
  const expected = Buffer.from(sha256, "hex");
  if (!timingSafeEqual(actual, expected)) throw new PolicyPinError(POLICY_PIN_CODES.INTEGRITY, "Owner policy integrity mismatch");
  return policy;
}
