import * as path from 'node:path';
import { FileOperation, MergeStrategyName, ProjectConfig, Template, ValidationIssue } from '../types';
import { CliError } from '../utils/errors';
import { readFileIfExists, writeFileEnsuringDir } from '../utils/fs';
import { renderTemplate, isTruthyPath } from '../utils/render';
import { merge as runMergeStrategy } from './composer';

export interface PlannedWrite {
  templateId: string;
  absDest: string;
  relDest: string;
  op: 'write' | 'append' | 'merge';
  content: string;
  mergeStrategy?: MergeStrategyName;
}

export interface FinalizeResult {
  writtenFiles: string[];
  conflicts: ValidationIssue[];
}

/**
 * Takes every selected template's planned writes (already in resolver
 * order) and actually writes the target directory: groups by destination
 * path, concatenates `append` contributions, folds `merge` contributions
 * through composer.ts, and hard-errors if two templates both plan a plain
 * `write`/`copy`/`template`/`create` to the same path (that pair should have
 * used `merge` instead — silently picking one would violate brief §25).
 */
export function finalizePlannedWrites(writes: PlannedWrite[]): FinalizeResult {
  const byDest = new Map<string, PlannedWrite[]>();
  for (const write of writes) {
    const group = byDest.get(write.absDest) ?? [];
    group.push(write);
    byDest.set(write.absDest, group);
  }

  const writtenFiles: string[] = [];
  const conflicts: ValidationIssue[] = [];

  for (const [absDest, group] of byDest) {
    const mergeGroup = group.filter((w) => w.op === 'merge');
    const appendGroup = group.filter((w) => w.op === 'append');
    const plainGroup = group.filter((w) => w.op === 'write');

    if (plainGroup.length > 1) {
      throw new CliError(`Multiple templates write "${absDest}" without merging.`, {
        reason: `Templates: ${plainGroup.map((w) => w.templateId).join(', ')}.`,
        suggestion: 'One of these templates should declare op: merge for this file instead of op: create/copy/template.',
      });
    }
    if (plainGroup.length === 1 && (mergeGroup.length > 0 || appendGroup.length > 0)) {
      throw new CliError(`"${absDest}" is both plainly written and merged/appended by different templates.`, {
        reason: `Plain writer: ${plainGroup[0].templateId}. Merge/append writers: ${[...mergeGroup, ...appendGroup].map((w) => w.templateId).join(', ')}.`,
        suggestion: 'All templates contributing to a shared file must use the same operation kind (merge, or append) for it.',
      });
    }

    let finalContent: string;
    if (plainGroup.length === 1) {
      finalContent = plainGroup[0].content;
    } else if (mergeGroup.length > 0) {
      const strategy = mergeGroup[0].mergeStrategy!;
      const result = runMergeStrategy(
        strategy,
        mergeGroup.map((w) => ({ templateId: w.templateId, content: w.content })),
      );
      finalContent = result.content;
      conflicts.push(...result.conflicts);
    } else {
      finalContent = appendGroup.map((w) => w.content).join('\n');
    }

    writeFileEnsuringDir(absDest, finalContent);
    writtenFiles.push(absDest);
  }

  return { writtenFiles, conflicts };
}

/**
 * Resolves one template's `files` operations (including nested `conditional`
 * operations) against `appRoot` into a flat list of planned writes. Does not
 * touch the filesystem — generator.ts collects every template's planned
 * writes first, so `merge` contributions to the same destination can be
 * folded together in one pass by composer.ts, instead of being partially
 * written and re-read (see docs/architecture.md "Generator").
 */
export function planTemplateFiles(template: Template, config: ProjectConfig, appRoot: string): PlannedWrite[] {
  const context = config as unknown as Record<string, unknown>;
  const writes: PlannedWrite[] = [];

  function planOne(operation: FileOperation): void {
    if (operation.op === 'conditional') {
      if (!operation.when || !operation.then) {
        throw new CliError(`Template "${template.id}" has a conditional file operation missing "when"/"then".`, {
          reason: 'This is a template authoring bug.',
        });
      }
      if (isTruthyPath(context, operation.when)) {
        for (const nested of operation.then) planOne(nested);
      }
      return;
    }

    const relDest = operation.dest;
    const absDest = path.join(appRoot, relDest);

    if (operation.op === 'merge') {
      if (!operation.mergeStrategy) {
        throw new CliError(`Template "${template.id}"'s merge operation for "${relDest}" is missing mergeStrategy.`, {
          reason: 'This is a template authoring bug.',
        });
      }
      const content = resolveContent(template, operation, context);
      writes.push({ templateId: template.id, absDest, relDest, op: 'merge', content, mergeStrategy: operation.mergeStrategy });
      return;
    }

    const content = resolveContent(template, operation, context);
    writes.push({ templateId: template.id, absDest, relDest, op: operation.op === 'append' ? 'append' : 'write', content });
  }

  for (const operation of template.files) planOne(operation);
  return writes;
}

function resolveContent(template: Template, operation: FileOperation, context: Record<string, unknown>): string {
  switch (operation.op) {
    case 'copy': {
      return readSource(template, operation);
    }
    case 'template': {
      return renderTemplate(readSource(template, operation), context);
    }
    case 'create':
    case 'append':
    case 'merge': {
      if (operation.content !== undefined) return operation.content;
      if (operation.src) return readSource(template, operation);
      throw new CliError(`Template "${template.id}"'s "${operation.op}" operation for "${operation.dest}" has neither content nor src.`, {
        reason: 'This is a template authoring bug.',
      });
    }
    default:
      throw new CliError(`Unknown file operation "${operation.op}" in template "${template.id}".`, { reason: 'Unsupported operation type.' });
  }
}

function readSource(template: Template, operation: FileOperation): string {
  if (!operation.src) {
    throw new CliError(`Template "${template.id}"'s "${operation.op}" operation for "${operation.dest}" is missing "src".`, {
      reason: 'This is a template authoring bug.',
    });
  }
  const sourcePath = path.join(template.dir, 'files', operation.src);
  const content = readFileIfExists(sourcePath);
  if (content === undefined) {
    throw new CliError(`Template "${template.id}" references missing source file: ${operation.src}`, {
      reason: `Expected to find it at ${sourcePath}.`,
    });
  }
  return content;
}
