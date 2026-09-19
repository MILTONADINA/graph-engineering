/**
 * Deliberately not a dependency on the `semver` package — this project's
 * templates only ever declare simple `^x.y.z` caret ranges (see
 * schemas/template.schema.json's packageRef description), so a small,
 * dependency-free comparator covers the real cases. If a future template
 * needs a more exotic range, this is the file to replace with `semver`.
 */

interface ParsedRange {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

function parseCaretRange(range: string): ParsedRange | undefined {
  const match = /^\^?(\d+)\.(\d+)\.(\d+)$/.exec(range.trim());
  if (!match) return undefined;
  return { raw: range, major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export interface VersionResolution {
  chosen: string;
  compatible: boolean;
}

/**
 * Given two version ranges requested by different templates for the same
 * package, picks the higher one when they share a major version (caret
 * ranges are backward compatible within a major), and reports `compatible:
 * false` when majors differ — the caller (composer.ts) surfaces that as a
 * conflict requiring a user decision (brief §25) rather than guessing.
 */
export function resolvePackageVersion(a: string, b: string): VersionResolution {
  if (a === b) return { chosen: a, compatible: true };

  const parsedA = parseCaretRange(a);
  const parsedB = parseCaretRange(b);
  if (!parsedA || !parsedB) {
    return { chosen: a, compatible: false };
  }
  if (parsedA.major !== parsedB.major) {
    return { chosen: a, compatible: false };
  }

  const higher =
    parsedA.minor !== parsedB.minor
      ? (parsedA.minor > parsedB.minor ? parsedA : parsedB)
      : parsedA.patch >= parsedB.patch
        ? parsedA
        : parsedB;

  return { chosen: higher.raw, compatible: true };
}
