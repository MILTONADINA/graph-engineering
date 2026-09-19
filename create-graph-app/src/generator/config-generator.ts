import * as yaml from 'js-yaml';
import { EnvironmentVariable, ProjectConfig, Template, ValidationIssue } from '../types';
import { resolvePackageVersion } from '../resolver/version';
import { isTruthyPath } from '../utils/render';

export interface PackageJsonResult {
  content: string;
  conflicts: ValidationIssue[];
}

/**
 * Builds one app's package.json from the structured `dependencies`/`scripts`
 * metadata of every template targeting it — the only code path that writes
 * package.json (see composer.ts's file header for why). `templates` must
 * already be in resolver order; the first template to declare a script name
 * wins, with every later collision reported as a conflict rather than
 * silently overwritten (brief §25).
 */
export function buildPackageJson(packageName: string, templates: Template[], config: ProjectConfig): PackageJsonResult {
  const conflicts: ValidationIssue[] = [];
  const dependencies: Record<string, string> = {};
  const devDependencies: Record<string, string> = {};
  const scripts: Record<string, string> = {};
  const context = config as unknown as Record<string, unknown>;
  const included = (pkg: { when?: string }) => !pkg.when || isTruthyPath(context, pkg.when);

  for (const template of templates) {
    for (const pkg of template.dependencies.dependencies.filter(included)) {
      mergePackageEntry(dependencies, pkg.name, pkg.version, template.id, conflicts);
    }
    for (const pkg of template.dependencies.devDependencies.filter(included)) {
      mergePackageEntry(devDependencies, pkg.name, pkg.version, template.id, conflicts);
    }
    for (const [name, command] of Object.entries(template.scripts)) {
      if (scripts[name] && scripts[name] !== command) {
        conflicts.push({
          code: 'script-conflict',
          message: `npm script "${name}" is defined differently by multiple templates; kept "${scripts[name]}" over "${template.id}"'s "${command}".`,
          templateIds: [template.id],
        });
        continue;
      }
      scripts[name] = command;
    }
  }

  const packageJson = {
    name: packageName,
    version: '0.1.0',
    private: true,
    scripts,
    dependencies: sortKeys(dependencies),
    devDependencies: sortKeys(devDependencies),
  };

  return { content: JSON.stringify(packageJson, null, 2) + '\n', conflicts };
}

function mergePackageEntry(
  target: Record<string, string>,
  name: string,
  version: string,
  templateId: string,
  conflicts: ValidationIssue[],
): void {
  if (!target[name]) {
    target[name] = version;
    return;
  }
  const resolution = resolvePackageVersion(target[name], version);
  if (!resolution.compatible) {
    conflicts.push({
      code: 'dependency-version-conflict',
      message: `"${name}" requested at incompatible versions ("${target[name]}" vs. "${version}" from "${templateId}") — kept "${target[name]}". Review manually.`,
      templateIds: [templateId],
    });
  }
  target[name] = resolution.chosen;
}

function sortKeys(obj: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * `.env.example` from every selected template's declared `environment`
 * variables, grouped under a header comment per contributing template.
 * Never writes a real value — `default` is documentation-only sample text
 * (e.g. "http://localhost:3000"), and secrets get an empty value always,
 * matching the discipline graph-templates/storage.* already documents.
 */
export function buildEnvExample(templates: Template[]): string {
  const blocks: string[] = [];
  for (const template of templates) {
    if (template.environment.length === 0) continue;
    const lines = template.environment.map((variable) => formatEnvLine(variable));
    blocks.push(`# ${template.name}\n${lines.join('\n')}`);
  }
  return blocks.join('\n\n') + '\n';
}

function formatEnvLine(variable: EnvironmentVariable): string {
  const value = variable.secret ? '' : (variable.default ?? '');
  const comment = variable.description ? `# ${variable.description}\n` : '';
  return `${comment}${variable.name}=${value}`;
}

export function collectEnvironmentVariables(templates: Template[]): EnvironmentVariable[] {
  return templates.flatMap((template) => template.environment);
}

/** project.config.yaml — the reproducibility source of truth (brief §9). */
export function buildProjectConfigYaml(config: ProjectConfig): string {
  return yaml.dump(config, { indent: 2, sortKeys: false });
}
