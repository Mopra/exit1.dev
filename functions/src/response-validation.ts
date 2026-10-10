/**
 * Response body validation for HTTP/REST checks: text assertions and JSONPath
 * assertions, evaluated against the (possibly truncated) response body snippet.
 *
 * Kept pure and dependency-free like json-path.ts, because it runs on the VPS
 * runner too (via the compiled functions/lib).
 *
 * Shape is backwards compatible. A legacy check has at most one JSONPath
 * assertion (jsonPath / jsonPathOperator / expectedValue) and a containsText
 * list that must all be present. Newer checks may add:
 *   - containsTextMode: 'any' to pass when at least one containsText entry is present
 *   - notContainsText: entries that must NOT appear
 *   - jsonAssertions + jsonAssertionsMode: several JSONPath assertions joined by AND / OR
 * When jsonAssertions is non-empty it replaces the legacy single assertion.
 */

import { assertJsonPath, type JsonPathOperator } from "./json-path";

export type MatchMode = "all" | "any";

export interface JsonAssertion {
  path: string;
  operator?: JsonPathOperator;
  expectedValue?: unknown;
}

export interface ResponseValidation {
  containsText?: string[];
  containsTextMode?: MatchMode;
  notContainsText?: string[];
  jsonPath?: string;
  expectedValue?: unknown;
  jsonPathOperator?: JsonPathOperator;
  jsonAssertions?: JsonAssertion[];
  jsonAssertionsMode?: MatchMode;
}

export interface ResponseValidationResult {
  passed: boolean;
  reason?: string;
}

/** The JSONPath assertions a check actually runs: the list if set, else the legacy single one. */
export function effectiveJsonAssertions(validation: ResponseValidation): JsonAssertion[] {
  const list = (validation.jsonAssertions ?? []).filter(
    (a) => a && typeof a.path === "string" && a.path.trim() !== ""
  );
  if (list.length > 0) return list;
  if (validation.jsonPath) {
    return [{
      path: validation.jsonPath,
      operator: validation.jsonPathOperator,
      expectedValue: validation.expectedValue,
    }];
  }
  return [];
}

/** True when the validation config asks for anything at all (so the body must be read). */
export function hasResponseValidation(validation: ResponseValidation | undefined | null): boolean {
  if (!validation) return false;
  return Boolean(
    validation.containsText?.length ||
    validation.notContainsText?.length ||
    validation.jsonPath ||
    validation.expectedValue !== undefined ||
    validation.jsonAssertions?.length
  );
}

const nonEmpty = (list: string[] | undefined): string[] =>
  (list ?? []).filter((t) => typeof t === "string" && t.length > 0);

export function evaluateResponseValidation(
  body: string,
  validation: ResponseValidation,
  maxBodyBytes: number,
): ResponseValidationResult {
  const lowerBody = body.toLowerCase();
  const includes = (text: string) => lowerBody.includes(text.toLowerCase());

  // Required text (case-insensitive substring).
  const required = nonEmpty(validation.containsText);
  if (required.length > 0) {
    if (validation.containsTextMode === "any") {
      if (!required.some(includes)) {
        return {
          passed: false,
          reason: `Response did not contain any of the expected texts: ${required.map((t) => JSON.stringify(t)).join(", ")}`,
        };
      }
    } else {
      const missing = required.find((t) => !includes(t));
      if (missing !== undefined) {
        return { passed: false, reason: `Response did not contain expected text: ${JSON.stringify(missing)}` };
      }
    }
  }

  // Forbidden text. Only the snippet is searched, so text past the cap goes unseen.
  const forbidden = nonEmpty(validation.notContainsText).find(includes);
  if (forbidden !== undefined) {
    return { passed: false, reason: `Response contained forbidden text: ${JSON.stringify(forbidden)}` };
  }

  const assertions = effectiveJsonAssertions(validation);
  if (assertions.length === 0) return { passed: true };

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(body);
  } catch {
    return {
      passed: false,
      reason: body.length >= maxBodyBytes
        ? `JSONPath validation failed: response body is not valid JSON within the first ${maxBodyBytes} bytes`
        : "JSONPath validation failed: response body is not valid JSON",
    };
  }

  const results = assertions.map((a) =>
    assertJsonPath(parsedBody, a.path, a.operator ?? "equals", a.expectedValue)
  );
  const failures = results
    .map((r, i) => (r.passed ? null : r.reason ?? `JSONPath validation failed: ${assertions[i].path}`))
    .filter((r): r is string => r !== null);

  if (validation.jsonAssertionsMode === "any" && assertions.length > 1) {
    if (failures.length < assertions.length) return { passed: true };
    return { passed: false, reason: `No JSON assertion passed: ${failures.join("; ")}` };
  }
  if (failures.length === 0) return { passed: true };
  return {
    passed: false,
    reason: failures.length === 1
      ? failures[0]
      : `${failures.length} JSON assertions failed: ${failures.join("; ")}`,
  };
}
