import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import Ajv, { ValidateFunction } from 'ajv/dist/2020';
import addFormats from 'ajv-formats';
import { ProjectConfig } from '../types';
import { CliError } from '../utils/errors';
import { PACKAGE_ROOT } from '../registry/loader';

let cachedValidator: ValidateFunction | undefined;

function getValidator(): ValidateFunction {
  if (!cachedValidator) {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const schemaPath = path.join(PACKAGE_ROOT, 'schemas', 'project-config.schema.json');
    cachedValidator = ajv.compile(JSON.parse(fs.readFileSync(schemaPath, 'utf8')));
  }
  return cachedValidator;
}

export function validateProjectConfig(config: unknown): asserts config is ProjectConfig {
  const validator = getValidator();
  if (!validator(config)) {
    const details = (validator.errors ?? []).map((e) => `  - ${e.instancePath || '(root)'} ${e.message}`).join('\n');
    throw new CliError('Invalid project configuration.', { reason: details });
  }
}

export function loadProjectConfigFile(filePath: string): ProjectConfig {
  if (!fs.existsSync(filePath)) {
    throw new CliError(`Config file not found: ${filePath}`, {
      reason: 'The path passed to --config does not exist.',
      suggestion: 'Check the path, or omit --config to run the interactive wizard instead.',
    });
  }
  const raw = yaml.load(fs.readFileSync(filePath, 'utf8'));
  validateProjectConfig(raw);
  return raw;
}

export interface CliFlags {
  name?: string;
  frontend?: string;
  state?: string;
  ui?: string;
  backend?: string;
  database?: string;
  storage?: string;
}

const FLAG_TO_PROVIDER: Record<string, string> = {
  neon: 'neon-postgres',
  s3: 'aws-s3',
};

function normalizeProvider(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return FLAG_TO_PROVIDER[value] ?? value;
}

/**
 * Builds a ProjectConfig from --non-interactive CLI flags, applying
 * DEFAULT_CONFIG for anything unspecified. See cli/index.ts for how this is
 * combined with a --config file (a file takes precedence; flags override
 * individual fields on top of it when both are given).
 */
export function configFromFlags(flags: CliFlags, defaults: ProjectConfig): ProjectConfig {
  const merged: unknown = {
    project: { name: flags.name ?? defaults.project.name, type: defaults.project.type },
    frontend: {
      framework: flags.frontend ?? defaults.frontend?.framework,
      stateManagement: normalizeProvider(flags.state) ?? defaults.frontend?.stateManagement,
      ui: flags.ui ?? defaults.frontend?.ui,
    },
    backend: { framework: flags.backend ?? defaults.backend?.framework },
    database: { provider: normalizeProvider(flags.database) ?? defaults.database?.provider },
    storage: { provider: normalizeProvider(flags.storage) ?? defaults.storage?.provider },
  };
  validateProjectConfig(merged);
  return merged;
}
