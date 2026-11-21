// ============================================
// RUBRIC — SIZE OF A STRUCTURED-OUTPUT SCHEMA (issue #456)
// ============================================
//
// The provider compiles every output schema we send into a grammar, and
// refuses a schema whose grammar is too large (HTTP 400 "The compiled grammar
// is too large"). Its published limits are 24 optional parameters and 16
// union-typed parameters per request, plus an UNPUBLISHED limit on the size of
// the compiled grammar, which optional parameters, unions and nesting push up
// together (see the size note above `buildIntakeOutputSchema` in
// rubric-prompt.ts). The v13 intake schema met every published limit and was
// still refused live (#335).
//
// This module measures a schema offline, with no network and no model, so a
// schema that grows past what the provider has been seen to ACCEPT is caught
// by a unit test (rubric-intake-schema.test.ts) and by the probe command
// (scripts/probe-intake-schema.ts) before any paid call. The ceilings below
// are what was accepted live, not the provider's published maxima.
//
// Pure: it reads the schema object and returns numbers and paths. A path is
// built from schema property names only (never from any model output).

/** What `measureSchema` reports about one schema. */
export interface SchemaSize {
  // Length of the schema as sent (JSON, no whitespace).
  bytes: number;
  // Properties of an object schema that are not in its `required` list.
  optional: number;
  // Parameters with a union type: an `anyOf`, or a `type` that is an array.
  unions: number;
  // Deepest nesting: one level per object property and per array item.
  maxDepth: number;
  // Where each optional parameter and each union is (for example
  // `$.intakeQuestions[].helpText`), so a failing test says what to fix.
  optionalPaths: string[];
  unionPaths: string[];
}

/** The ceilings a schema is held to (inclusive). */
export interface SchemaSizeLimits {
  maxOptional: number;
  maxUnions: number;
  maxDepth: number;
}

/**
 * (#456) The intake schema's ceilings. 11 optional parameters and depth 5 are
 * what the pre-#235 intake schema had when it was accepted live (prompt v10,
 * a whole shared rulebook drafted on 2026-11-14); unions are 0 because they are the most
 * expensive part of a grammar and the intake answer needs none (condition
 * values are strings, typed in code).
 */
export const INTAKE_SCHEMA_LIMITS: SchemaSizeLimits = { maxOptional: 11, maxUnions: 0, maxDepth: 5 };

/**
 * (#456) The criteria schema's ceilings: exactly what it has today (17
 * optional, 1 union: `check.value`), which was accepted live in the #335 run.
 * Its depth (6) was accepted too. #456 does not change this schema; the pin
 * only stops it from growing unnoticed.
 */
export const CRITERIA_SCHEMA_LIMITS: SchemaSizeLimits = { maxOptional: 17, maxUnions: 1, maxDepth: 6 };

/**
 * Measure a JSON Schema built by rubric-prompt.ts (the subset it uses:
 * object / array / scalar types, `enum`, `anyOf`).
 *
 * @param schema the schema exactly as it is sent to the provider
 */
export function measureSchema(schema: Record<string, unknown>): SchemaSize {
  const optionalPaths: string[] = [];
  const unionPaths: string[] = [];
  let maxDepth = 0;

  /** Walk one sub-schema at `path`, `depth` levels down. */
  const walk = (s: Record<string, unknown>, path: string, depth: number): void => {
    maxDepth = Math.max(maxDepth, depth);
    // A union: count it once, then walk each branch at the same depth (a
    // branch may hold objects with optional properties of its own).
    if (Array.isArray(s.anyOf)) {
      unionPaths.push(path);
      (s.anyOf as Record<string, unknown>[]).forEach((branch, i) => walk(branch, `${path}|${i}`, depth));
      return;
    }
    // A type array (`["string", "null"]`) is a union too.
    if (Array.isArray(s.type)) unionPaths.push(path);
    if (s.type === "object") {
      const required = new Set((s.required as string[] | undefined) ?? []);
      for (const [key, sub] of Object.entries((s.properties ?? {}) as Record<string, Record<string, unknown>>)) {
        if (!required.has(key)) optionalPaths.push(`${path}.${key}`);
        walk(sub, `${path}.${key}`, depth + 1);
      }
    }
    if (s.type === "array" && s.items) walk(s.items as Record<string, unknown>, `${path}[]`, depth + 1);
  };

  walk(schema, "$", 0);
  return { bytes: JSON.stringify(schema).length, optional: optionalPaths.length, unions: unionPaths.length, maxDepth, optionalPaths, unionPaths };
}

/**
 * The ceilings a measured schema goes over, in plain words (empty = within
 * every one). Each line names the measured number and the paths involved.
 */
export function schemaSizeProblems(size: SchemaSize, limits: SchemaSizeLimits): string[] {
  const problems: string[] = [];
  if (size.unions > limits.maxUnions) problems.push(`${size.unions} union-typed parameter(s), at most ${limits.maxUnions}: ${size.unionPaths.join(", ")}`);
  if (size.optional > limits.maxOptional) problems.push(`${size.optional} optional parameter(s), at most ${limits.maxOptional}: ${size.optionalPaths.join(", ")}`);
  if (size.maxDepth > limits.maxDepth) problems.push(`nesting depth ${size.maxDepth}, at most ${limits.maxDepth}`);
  return problems;
}

/** One line for a person (the probe, a test diagnostic): the counts, then the paths. */
export function describeSchemaSize(size: SchemaSize): string {
  return [
    `bytes ${size.bytes}, optional ${size.optional}, unions ${size.unions}, max depth ${size.maxDepth}`,
    `optional: ${size.optionalPaths.join(", ") || "none"}`,
    `unions: ${size.unionPaths.join(", ") || "none"}`,
  ].join("\n");
}
