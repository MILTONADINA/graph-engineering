import { Registry } from '../registry/registry';
import { ValidationIssue, ValidationResult } from '../types';

/**
 * Pre-generation compatibility/conflict/dependency checks over a selected
 * template id set. Never mutates the selection — see dependency-resolver.ts
 * for why an unmet `requires` is reported, not auto-fixed (brief §37).
 */
export function checkCompatibility(registry: Registry, selectedIds: string[]): ValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const selected = selectedIds.map((id) => registry.requireById(id));
  const providedCapabilities = new Set(selected.flatMap((template) => template.provides));

  // Unmet `requires`
  for (const template of selected) {
    for (const capability of template.requires) {
      if (!providedCapabilities.has(capability)) {
        errors.push({
          code: 'unmet-requirement',
          message: `"${template.name}" requires "${capability}", but no selected template provides it.`,
          templateIds: [template.id],
        });
      }
    }
  }

  // Hard conflicts
  for (const { a, b } of registry.findConflicts(selectedIds)) {
    errors.push({
      code: 'conflict',
      message: `"${registry.getById(a)?.name ?? a}" conflicts with "${registry.getById(b)?.name ?? b}" — both provide the same capability and cannot be used together.`,
      templateIds: [a, b],
    });
  }

  // Duplicate `provides` within the same category that aren't declared conflicts —
  // e.g. two templates both claiming "routing" without listing each other in
  // conflictsWith is very likely an oversight in a future third-party template,
  // not a deliberate choice, so it's a warning rather than a silent pass.
  const byCapability = new Map<string, string[]>();
  for (const template of selected) {
    for (const capability of template.provides) {
      const ids = byCapability.get(capability) ?? [];
      ids.push(template.id);
      byCapability.set(capability, ids);
    }
  }
  for (const [capability, ids] of byCapability) {
    if (ids.length > 1) {
      const alreadyConflicting = registry.findConflicts(ids).length > 0;
      if (!alreadyConflicting) {
        warnings.push({
          code: 'duplicate-capability',
          message: `More than one selected template provides "${capability}": ${ids.join(', ')}. This may be intentional, but they aren't declared compatible or conflicting with each other.`,
          templateIds: ids,
        });
      }
    }
  }

  // Package version overlaps across selected templates
  const versionsByPackage = new Map<string, Array<{ templateId: string; version: string }>>();
  for (const template of selected) {
    for (const pkg of [...template.dependencies.dependencies, ...template.dependencies.devDependencies]) {
      const entries = versionsByPackage.get(pkg.name) ?? [];
      entries.push({ templateId: template.id, version: pkg.version });
      versionsByPackage.set(pkg.name, entries);
    }
  }
  for (const [pkgName, entries] of versionsByPackage) {
    const distinctVersions = new Set(entries.map((entry) => entry.version));
    if (distinctVersions.size > 1) {
      warnings.push({
        code: 'version-mismatch',
        message: `Multiple selected templates request different version ranges for "${pkgName}": ${entries.map((e) => `${e.templateId}@${e.version}`).join(', ')}. The generator will pick the highest compatible range — see docs/architecture.md "composer.ts".`,
        templateIds: entries.map((entry) => entry.templateId),
      });
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
