import { describe, expect, it } from 'vitest';
import { Registry } from '../src/registry/registry';
import { buildPackageJson, buildEnvExample, buildProjectConfigYaml } from '../src/generator/config-generator';
import { ProjectConfig } from '../src/types';

const registry = Registry.load();

describe('config-generator: buildPackageJson', () => {
  it('omits tailwindcss/postcss/autoprefixer when frontend.ui is none', () => {
    const config: ProjectConfig = { project: { name: 'x', type: 'frontend' }, frontend: { framework: 'nextjs', stateManagement: 'none', ui: 'none' } };
    const nextjs = registry.requireById('frontend.nextjs');
    const { content } = buildPackageJson('x-web', [nextjs], config);
    const parsed = JSON.parse(content);
    expect(parsed.devDependencies.tailwindcss).toBeUndefined();
  });

  it('includes tailwindcss/postcss/autoprefixer when frontend.ui is shadcn', () => {
    const config: ProjectConfig = { project: { name: 'x', type: 'frontend' }, frontend: { framework: 'nextjs', stateManagement: 'none', ui: 'shadcn' } };
    const nextjs = registry.requireById('frontend.nextjs');
    const { content } = buildPackageJson('x-web', [nextjs], config);
    const parsed = JSON.parse(content);
    expect(parsed.devDependencies.tailwindcss).toBeDefined();
  });

  it('collects scripts from every template without collision on the MVP set', () => {
    const config: ProjectConfig = { project: { name: 'x', type: 'backend' } };
    const templates = [registry.requireById('backend.express'), registry.requireById('database.neon-postgres')];
    const { content, conflicts } = buildPackageJson('x-api', templates, config);
    const parsed = JSON.parse(content);
    expect(parsed.scripts.dev).toBe('tsx watch src/app.ts');
    expect(parsed.scripts.dbGenerate).toBe('drizzle-kit generate');
    expect(conflicts).toEqual([]);
  });

  it('never writes an empty dependencies/devDependencies key as anything but an object', () => {
    const config: ProjectConfig = { project: { name: 'x', type: 'backend' } };
    const { content } = buildPackageJson('x', [], config);
    const parsed = JSON.parse(content);
    expect(parsed.dependencies).toEqual({});
    expect(parsed.devDependencies).toEqual({});
  });
});

describe('config-generator: buildEnvExample', () => {
  it('never writes a real value for a secret variable', () => {
    const storage = registry.requireById('storage.aws-s3');
    const content = buildEnvExample([storage]);
    expect(content).toMatch(/AWS_ACCESS_KEY_ID=\n/);
    expect(content).toMatch(/AWS_SECRET_ACCESS_KEY=\n/);
  });

  it('writes the declared default for a non-secret variable', () => {
    const storage = registry.requireById('storage.aws-s3');
    const content = buildEnvExample([storage]);
    expect(content).toContain('AWS_BUCKET_NAME=media');
  });

  it('groups variables under a header comment per contributing template', () => {
    const content = buildEnvExample([registry.requireById('backend.express'), registry.requireById('database.neon-postgres')]);
    expect(content).toContain('# Express.js');
    expect(content).toContain('# Neon PostgreSQL');
  });
});

describe('config-generator: buildProjectConfigYaml', () => {
  it('round-trips through yaml.dump in a human-readable, stable shape', () => {
    const config: ProjectConfig = {
      project: { name: 'acme', type: 'fullstack' },
      frontend: { framework: 'nextjs', stateManagement: 'none', ui: 'none' },
      backend: { framework: 'express' },
    };
    const yamlText = buildProjectConfigYaml(config);
    expect(yamlText).toContain('name: acme');
    expect(yamlText).toContain('framework: nextjs');
  });
});
