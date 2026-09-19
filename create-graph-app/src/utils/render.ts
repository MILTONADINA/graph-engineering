/**
 * Minimal {{dotted.path}} substitution against a plain object, used by the
 * `template` file operation. Deliberately not a full templating engine (no
 * loops/conditionals inline in file content) — whole-file conditionals are
 * the `conditional` file operation's job (see file-generator.ts), keeping
 * this function's contract small and its output easy to reason about.
 */
export function renderTemplate(content: string, context: Record<string, unknown>): string {
  return content.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, expression: string) => {
    const value = getPath(context, expression);
    return value === undefined || value === null ? '' : String(value);
  });
}

function getPath(context: Record<string, unknown>, dottedPath: string): unknown {
  return dottedPath.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key];
    }
    return undefined;
  }, context);
}

/**
 * Used by the `conditional` file operation's `when` field. Supports:
 *   "frontend.ui"          -> truthy check (careful: the string "none" is
 *                              itself truthy — see the two forms below for
 *                              why this project's own templates never use
 *                              bare truthy checks against a *.provider/
 *                              *.framework/*.ui-style field, only against
 *                              genuinely optional/boolean-shaped fields)
 *   "frontend.ui=shadcn"   -> equality check
 *   "frontend.ui!=none"    -> inequality check — the form every MVP template
 *                              actually uses for enum-shaped config fields,
 *                              since "unset" is represented as the literal
 *                              string "none", not undefined (see
 *                              schemas/project-config.schema.json).
 */
export function isTruthyPath(context: Record<string, unknown>, expression: string): boolean {
  const notEqualsMatch = /^([\w.]+)!=(.+)$/.exec(expression);
  if (notEqualsMatch) {
    return String(getPath(context, notEqualsMatch[1]) ?? '') !== notEqualsMatch[2];
  }
  const equalsMatch = /^([\w.]+)=(.+)$/.exec(expression);
  if (equalsMatch) {
    return String(getPath(context, equalsMatch[1]) ?? '') === equalsMatch[2];
  }
  return Boolean(getPath(context, expression));
}
