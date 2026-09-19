import { Registry } from '../registry/registry';
import { resolve } from '../resolver/dependency-resolver';
import { ProjectConfig, ValidationResult } from '../types';
import { configToTemplateIds } from '../configuration/mapping';
import { isUsableTargetDir } from '../utils/fs';
import { ValidationIssue } from '../types';

/**
 * Everything checked before a single byte is written — brief §21's full
 * list: template compatibility, dependency conflicts, version conflicts
 * (all via resolver.checkCompatibility), plus the two things only the CLI
 * layer knows about: target directory usability and "does every selected
 * template id actually exist" (a typo in --non-interactive flags/--config
 * must fail here, not deep inside the generator).
 */
export function validateBeforeGenerate(
  registry: Registry,
  config: ProjectConfig,
  targetDir: string,
  options: { force: boolean },
): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const selectedIds = configToTemplateIds(config);
  for (const id of selectedIds) {
    if (!registry.getById(id)) {
      errors.push({
        code: 'unknown-template',
        message: `"${id}" is not a known template.`,
        templateIds: [id],
      });
    }
  }

  if (errors.length === 0) {
    const plan = resolve(registry, selectedIds);
    errors.push(...plan.validation.errors);
    warnings.push(...plan.validation.warnings);
  }

  if (!options.force && !isUsableTargetDir(targetDir)) {
    errors.push({
      code: 'target-dir-not-empty',
      message: `"${targetDir}" already exists and is not empty.`,
    });
  }

  return { valid: errors.length === 0, errors, warnings };
}
