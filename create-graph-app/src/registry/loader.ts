import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import Ajv, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { Template } from '../types';
import { CliError } from '../utils/errors';

/** Package root — dist/registry/loader.js -> dist/registry -> dist -> package root. */
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_TEMPLATES_DIR = path.join(PACKAGE_ROOT, 'templates');
const TEMPLATE_SCHEMA_PATH = path.join(PACKAGE_ROOT, 'schemas', 'template.schema.json');

let cachedValidator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false, useDefaults: true });
    addFormats(ajv);
    const schema = JSON.parse(fs.readFileSync(TEMPLATE_SCHEMA_PATH, 'utf8'));
    cachedValidator = ajv.compile(schema);
  }
  return cachedValidator;
}

function findTemplateFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      findTemplateFiles(full, out);
    } else if (entry.name === 'template.yaml') {
      out.push(full);
    }
  }
  return out;
}

/**
 * Loads and validates every template.yaml under `dirs` (default: this
 * package's bundled templates/). Plural by design — see docs/architecture.md
 * "Custom template support": a future --templates-dir flag just adds another
 * entry here.
 */
export function loadTemplates(dirs: string[] = [DEFAULT_TEMPLATES_DIR]): Template[] {
  const validator = getValidator();
  const templates: Template[] = [];
  const seenIds = new Set<string>();

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const templateFile of findTemplateFiles(dir)) {
      const raw = yaml.load(fs.readFileSync(templateFile, 'utf8'));
      if (!validator(raw)) {
        const details = (validator.errors ?? [])
          .map((error) => `  - ${error.instancePath || '(root)'} ${error.message}`)
          .join('\n');
        throw new CliError(`Invalid template metadata: ${templateFile}`, {
          reason: details,
          suggestion: 'This is a bug in the template itself, not something you can fix — please report it.',
        });
      }

      const template = raw as Omit<Template, 'dir'>;
      if (seenIds.has(template.id)) {
        throw new CliError(`Duplicate template id "${template.id}"`, {
          reason: `Found at ${templateFile} but another template already registered this id.`,
        });
      }
      seenIds.add(template.id);

      templates.push({ ...normalizeDefaults(template), dir: path.dirname(templateFile) });
    }
  }

  return templates;
}

function normalizeDefaults(template: Omit<Template, 'dir'>): Omit<Template, 'dir'> {
  return {
    ...template,
    requires: template.requires ?? [],
    compatibleWith: template.compatibleWith ?? [],
    conflictsWith: template.conflictsWith ?? [],
    dependencies: {
      dependencies: template.dependencies?.dependencies ?? [],
      devDependencies: template.dependencies?.devDependencies ?? [],
    },
    scripts: template.scripts ?? {},
    environment: template.environment ?? [],
    files: template.files ?? [],
    targetApp: template.targetApp ?? 'root',
  };
}

export { DEFAULT_TEMPLATES_DIR, PACKAGE_ROOT };
