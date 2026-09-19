import { MergeStrategyName, ValidationIssue } from '../types';

export interface MergeContribution {
  templateId: string;
  /** Raw content this template would write if it were the only contributor. */
  content: string;
}

export interface MergeResult {
  content: string;
  conflicts: ValidationIssue[];
}

/**
 * Dispatches to the named strategy. Each strategy takes every contributing
 * template's content for the SAME destination path, in resolver order, and
 * folds them into one final file — never last-writer-wins by accident (see
 * docs/architecture.md "composer.ts" / brief §25).
 *
 * Only `.gitignore`-shaped line sets and `tsconfig.json` go through here.
 * `package.json`, `.env.example`, and `project.config.yaml` are generated
 * entirely from structured template metadata (`dependencies`/`scripts`/
 * `environment`) by config-generator.ts — there is exactly one code path
 * that writes each of those three, by design.
 */
export function merge(strategy: MergeStrategyName, contributions: MergeContribution[]): MergeResult {
  switch (strategy) {
    case 'gitignore-lines':
      return mergeLineSet(contributions);
    case 'tsconfig-json':
      return mergeTsconfigJson(contributions);
    default:
      throw new Error(`Unknown merge strategy: ${strategy}`);
  }
}

/** Union of non-empty lines across contributions, deduplicated, grouped under one header comment per contributing template. */
function mergeLineSet(contributions: MergeContribution[]): MergeResult {
  const seen = new Set<string>();
  const blocks: string[] = [];

  for (const { templateId, content } of contributions) {
    const lines = content
      .split('\n')
      .map((line) => line.trimEnd())
      .filter((line) => line.length > 0 && !seen.has(line));
    if (lines.length === 0) continue;
    for (const line of lines) seen.add(line);
    blocks.push(`# ${templateId}\n${lines.join('\n')}`);
  }

  return { content: blocks.join('\n\n') + '\n', conflicts: [] };
}

function mergeTsconfigJson(contributions: MergeContribution[]): MergeResult {
  const conflicts: ValidationIssue[] = [];
  const compilerOptions: Record<string, unknown> = {};
  const includeSet = new Set<string>();

  for (const { templateId, content } of contributions) {
    const parsed = JSON.parse(content) as Record<string, any>;
    for (const [key, value] of Object.entries(parsed.compilerOptions ?? {})) {
      if (compilerOptions[key] !== undefined && JSON.stringify(compilerOptions[key]) !== JSON.stringify(value)) {
        conflicts.push({
          code: 'tsconfig-conflict',
          message: `Multiple templates set compilerOptions.${key} differently; kept the first over "${templateId}"'s value.`,
          templateIds: [templateId],
        });
        continue;
      }
      compilerOptions[key] = value;
    }
    for (const entry of parsed.include ?? []) includeSet.add(entry);
  }

  return {
    content: JSON.stringify({ compilerOptions, include: [...includeSet] }, null, 2) + '\n',
    conflicts,
  };
}
