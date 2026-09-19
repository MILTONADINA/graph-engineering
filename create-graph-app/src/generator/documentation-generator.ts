import * as path from 'node:path';
import { EnvironmentVariable, ProjectConfig, Template } from '../types';
import { readFileIfExists } from '../utils/fs';
import { renderTemplate } from '../utils/render';

export interface DocumentationFile {
  relPath: string;
  content: string;
}

/**
 * Builds every Markdown file the generated project ships — the root README
 * plus docs/SETUP.md, docs/ARCHITECTURE.md, docs/ENVIRONMENT.md,
 * docs/DEVELOPMENT.md, docs/README.md (an index into the others), and one
 * docs/templates/<id>.md per SELECTED template only (brief §14/§16 — never
 * document a technology the user didn't choose).
 */
export function buildDocumentation(
  config: ProjectConfig,
  templates: Template[],
  envVars: EnvironmentVariable[],
): DocumentationFile[] {
  const files: DocumentationFile[] = [
    { relPath: 'README.md', content: buildRootReadme(config, templates) },
    { relPath: 'docs/README.md', content: buildDocsIndex(templates) },
    { relPath: 'docs/SETUP.md', content: buildSetupDoc(config, templates, envVars) },
    { relPath: 'docs/ARCHITECTURE.md', content: buildArchitectureDoc(config, templates) },
    { relPath: 'docs/ENVIRONMENT.md', content: buildEnvironmentDoc(envVars) },
    { relPath: 'docs/DEVELOPMENT.md', content: buildDevelopmentDoc(config, templates) },
  ];

  for (const template of templates) {
    const doc = buildTemplateDoc(template, config);
    if (doc) {
      files.push({ relPath: `docs/templates/${template.id}.md`, content: doc });
    }
  }

  return files;
}

function stackLines(templates: Template[]): string {
  const byCategory = new Map<string, Template[]>();
  for (const template of templates) {
    const list = byCategory.get(template.category) ?? [];
    list.push(template);
    byCategory.set(template.category, list);
  }
  const lines: string[] = [];
  for (const [category, list] of byCategory) {
    lines.push(`### ${capitalize(category)}\n`);
    for (const template of list) lines.push(`- ${template.name}`);
    lines.push('');
  }
  return lines.join('\n');
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function buildRootReadme(config: ProjectConfig, templates: Template[]): string {
  return `# ${config.project.name}

Generated using [create-graph-app](https://www.npmjs.com/package/create-graph-app).

## Stack

${stackLines(templates)}
## Getting Started

\`\`\`sh
cp .env.example .env
# fill in .env, then:
npm install
npm run dev
\`\`\`

See \`docs/SETUP.md\` for the full walkthrough.

## Environment Variables

See \`docs/ENVIRONMENT.md\`.

## Development

See \`docs/DEVELOPMENT.md\`.

## Architecture

See \`docs/ARCHITECTURE.md\`.

## Documentation

See \`/docs\` — one file per technology you selected, plus setup/architecture/environment/development guides.

## Reproducing this project

This project's stack is recorded in \`project.config.yaml\`. Regenerate an equivalent project with:

\`\`\`sh
npx create-graph-app --config project.config.yaml
\`\`\`
`;
}

function buildDocsIndex(templates: Template[]): string {
  const templateLinks = templates
    .filter((template) => template.documentation)
    .map((template) => `- [${template.name}](templates/${template.id}.md)`)
    .join('\n');

  return `# Documentation Index

- [SETUP](SETUP.md) — install, configure, run
- [ARCHITECTURE](ARCHITECTURE.md) — how the selected templates fit together
- [ENVIRONMENT](ENVIRONMENT.md) — every environment variable this project needs
- [DEVELOPMENT](DEVELOPMENT.md) — day-to-day workflow

## Templates

${templateLinks}
`;
}

function buildSetupDoc(config: ProjectConfig, templates: Template[], envVars: EnvironmentVariable[]): string {
  const steps: string[] = ['1. `npm install`'];
  if (envVars.length > 0) {
    steps.push('2. `cp .env.example .env` and fill in the values described in [ENVIRONMENT.md](ENVIRONMENT.md)');
  }
  if (config.database?.provider === 'neon-postgres') {
    steps.push(`${steps.length + 1}. Create a Neon project and set \`DATABASE_URL\` in \`.env\``);
  }
  if (config.storage?.provider === 'aws-s3') {
    steps.push(`${steps.length + 1}. Create an S3 (or S3-compatible) bucket and set the \`AWS_*\` variables in \`.env\``);
  }
  steps.push(`${steps.length + 1}. \`npm run dev\``);

  return `# Setup

## Prerequisites

- Node.js >= 18
- npm

## Steps

${steps.join('\n')}

## What was generated

${stackLines(templates)}
`;
}

function buildArchitectureDoc(config: ProjectConfig, templates: Template[]): string {
  const isFullstack = config.project.type === 'fullstack';
  const layoutNote = isFullstack
    ? 'This is a full-stack project: the frontend lives in `apps/web`, the backend in `apps/api`, each with its own `package.json`.'
    : 'This is a single-app project — everything lives at the project root.';

  const templateList = templates
    .map((template) => `- **${template.name}** (\`${template.id}\`) — ${template.description}`)
    .join('\n');

  return `# Architecture

${layoutNote}

## Selected templates

${templateList}

## Why these templates

Each selected template is a self-contained unit (its own dependencies, environment variables, and generated files) composed by \`create-graph-app\`'s resolver — see that tool's own \`docs/architecture.md\` if you're curious how composition works. Nothing here is hand-wired; every file in this project traces back to one of the templates listed above.
`;
}

function buildEnvironmentDoc(envVars: EnvironmentVariable[]): string {
  if (envVars.length === 0) {
    return '# Environment Variables\n\nThis project has no required environment variables.\n';
  }
  const rows = envVars
    .map((v) => `| \`${v.name}\` | ${v.required ? 'Yes' : 'No'} | ${v.secret ? 'Yes' : 'No'} | ${v.description ?? ''} |`)
    .join('\n');

  return `# Environment Variables

| Name | Required | Secret | Description |
|---|---|---|---|
${rows}

Copy \`.env.example\` to \`.env\` and fill these in. Never commit \`.env\`.
`;
}

function buildDevelopmentDoc(config: ProjectConfig, templates: Template[]): string {
  const hasWeb = templates.some((t) => t.targetApp === 'web');
  const hasApi = templates.some((t) => t.targetApp === 'api');
  const commands: string[] = [];
  if (hasWeb && hasApi) {
    commands.push('- `npm run dev` (from the root) starts both `apps/web` and `apps/api`');
    commands.push('- `npm run dev --workspace apps/web` / `--workspace apps/api` to run just one');
  } else {
    commands.push('- `npm run dev` starts the app');
  }
  commands.push('- `npm run build` builds for production');
  commands.push('- `npm test` runs the test suite');

  return `# Development

## Commands

${commands.join('\n')}

## Project config

\`project.config.yaml\` at the project root records exactly which templates generated this project. Don't hand-edit generated files that a template owns without also updating that file's header comment (if present) — regenerating will otherwise look like drift.
`;
}

function buildTemplateDoc(template: Template, config: ProjectConfig): string | undefined {
  if (!template.documentation) return undefined;
  const sourcePath = path.join(template.dir, template.documentation);
  const raw = readFileIfExists(sourcePath);
  if (!raw) return undefined;
  return renderTemplate(raw, config as unknown as Record<string, unknown>);
}
