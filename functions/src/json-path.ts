/**
 * Minimal, dependency-free JSONPath resolver + assertion helper.
 *
 * Deliberately supports only the subset needed to validate LLM / REST API JSON
 * responses: dot paths (`$.a.b`), numeric array indices (`$.a[0].b`), and
 * bracket-quoted keys (`$['a-b'].c`). It does NOT support wildcards, recursive
 * descent (`..`), filters, or slices.
 *
 * Why a hand-rolled subset instead of a JSONPath library: this code runs against
 * untrusted upstream response bodies on both Cloud Functions and the VPS runner
 * (which imports the compiled `functions/lib`). Keeping it dependency-free avoids
 * a cross-package dependency-resolution risk on the VPS and sidesteps the ReDoS /
 * unbounded-recursion surface of a full JSONPath engine.
 */

export type JsonPathOperator = "equals" | "not_equals" | "contains" | "exists";

export const JSON_PATH_OPERATORS: readonly JsonPathOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "exists",
];

export interface JsonPathAssertionResult {
  passed: boolean;
  /** Human-readable explanation when `passed` is false; surfaced as the check error. */
  reason?: string;
}

/**
 * Parse a JSONPath-lite expression into an ordered list of segments
 * (object keys as strings, array indices as numbers).
 * Returns `null` if the expression uses unsupported syntax.
 */
export function parseJsonPath(path: string): Array<string | number> | null {
  let expr = path.trim();
  if (expr.startsWith("$")) expr = expr.slice(1);

  const segments: Array<string | number> = [];
  let i = 0;
  const len = expr.length;

  const readBareKey = (): string => {
    let key = "";
    while (i < len && expr[i] !== "." && expr[i] !== "[") {
      key += expr[i++];
    }
    return key;
  };

  while (i < len) {
    const ch = expr[i];

    if (ch === ".") {
      i++;
      if (expr[i] === ".") return null; // recursive descent (`..`) unsupported
      // Allow a bracket to immediately follow a dot (e.g. `.[0]`).
      if (expr[i] === "[") continue;
      const key = readBareKey();
      if (key.length === 0) {
        // Tolerate a trailing dot; anything else is malformed.
        if (i >= len) break;
        return null;
      }
      segments.push(key);
    } else if (ch === "[") {
      const end = expr.indexOf("]", i);
      if (end === -1) return null;
      const inner = expr.slice(i + 1, end).trim();
      if (
        (inner.startsWith("'") && inner.endsWith("'")) ||
        (inner.startsWith('"') && inner.endsWith('"'))
      ) {
        segments.push(inner.slice(1, -1));
      } else if (/^\d+$/.test(inner)) {
        segments.push(Number(inner));
      } else {
        return null; // wildcards, filters, slices unsupported
      }
      i = end + 1;
    } else {
      // Leading key with no dot prefix (e.g. `model`).
      const key = readBareKey();
      if (key.length === 0) return null;
      segments.push(key);
    }
  }

  return segments;
}

/**
 * Resolve a JSONPath-lite expression against a parsed JSON value.
 * Returns `undefined` if any segment is missing or the path is unsupported.
 */
export function resolveJsonPath(root: unknown, path: string): unknown {
  const segments = parseJsonPath(path);
  if (segments === null) return undefined;

  let current: unknown = root;
  for (const seg of segments) {
    if (current === null || current === undefined) return undefined;
    if (typeof seg === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[seg];
    } else {
      if (typeof current !== "object" || Array.isArray(current)) return undefined;
      current = (current as Record<string, unknown>)[seg];
    }
  }
  return current;
}

const isScalar = (v: unknown): boolean =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

/**
 * Equality with pragmatic leniency: objects/arrays compare by stable JSON,
 * scalars compare by string form so a form-entered `"16"` / `"true"` matches a
 * typed JSON `16` / `true` in the response.
 */
const valuesEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (a && b && typeof a === "object" && typeof b === "object") {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  if (isScalar(a) && isScalar(b)) return String(a) === String(b);
  return false;
};

const display = (v: unknown): string => {
  if (v === undefined) return "undefined";
  if (typeof v === "string") return JSON.stringify(v);
  if (v === null || typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}...` : s;
  } catch {
    return String(v);
  }
};

/**
 * Evaluate a single JSONPath assertion against a parsed JSON value.
 * `expectedValue` is ignored for the `exists` operator.
 */
export function assertJsonPath(
  root: unknown,
  path: string,
  operator: JsonPathOperator = "equals",
  expectedValue?: unknown,
): JsonPathAssertionResult {
  if (parseJsonPath(path) === null) {
    return { passed: false, reason: `Unsupported or invalid JSONPath: ${path}` };
  }
  const resolved = resolveJsonPath(root, path);

  switch (operator) {
    case "exists":
      return resolved !== undefined
        ? { passed: true }
        : { passed: false, reason: `JSONPath ${path} did not match anything` };

    case "contains": {
      if (resolved === undefined) {
        return { passed: false, reason: `JSONPath ${path} did not match anything` };
      }
      const passed = Array.isArray(resolved)
        ? resolved.some((el) => valuesEqual(el, expectedValue))
        : String(resolved).includes(String(expectedValue));
      return passed
        ? { passed: true }
        : {
            passed: false,
            reason: `JSONPath ${path} expected to contain ${display(expectedValue)}, got ${display(resolved)}`,
          };
    }

    case "not_equals":
      return !valuesEqual(resolved, expectedValue)
        ? { passed: true }
        : { passed: false, reason: `JSONPath ${path} expected to not equal ${display(expectedValue)}` };

    case "equals":
    default:
      return valuesEqual(resolved, expectedValue)
        ? { passed: true }
        : {
            passed: false,
            reason: `JSONPath ${path} expected ${display(expectedValue)}, got ${display(resolved)}`,
          };
  }
}
