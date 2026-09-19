import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Black-box CLI tests against the built dist/cli/index.js — only the
 * non-interactive paths (list/info/validate/--dry-run/--non-interactive),
 * since the wizard itself needs a real TTY (@clack/prompts fails fast
 * without one — see docs/troubleshooting.md). Requires `npm run build`
 * first, same as tests/packaging.test.ts.
 */
const cliPath = path.resolve(__dirname, '..', 'dist', 'cli', 'index.js');

function runCli(args: string[], cwd: string): { status: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [cliPath, ...args], { cwd, encoding: 'utf8', stdio: 'pipe' });
    return { status: 0, stdout, stderr: '' };
  } catch (error: any) {
    return { status: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'create-graph-app-cli-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('create-graph-app list', () => {
  it('exits 0 and lists all six MVP templates grouped by category', () => {
    const result = runCli(['list'], tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('frontend.nextjs');
    expect(result.stdout).toContain('backend.express');
    expect(result.stdout).toContain('database.neon-postgres');
    expect(result.stdout).toContain('storage.aws-s3');
  });

  it('list frontend narrows to just the frontend category', () => {
    const result = runCli(['list', 'frontend'], tmpDir);
    expect(result.stdout).toContain('frontend.nextjs');
    expect(result.stdout).not.toContain('backend.express');
  });
});

describe('create-graph-app info', () => {
  it('prints full metadata for a known template', () => {
    const result = runCli(['info', 'backend.express'], tmpDir);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Express.js');
    expect(result.stdout).toContain('Provides: backend');
  });

  it('exits 1 with a helpful message for an unknown template', () => {
    const result = runCli(['info', 'nope.nope'], tmpDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Unknown template');
  });
});

describe('create-graph-app --non-interactive --dry-run', () => {
  it('exits 0, reports counts, and writes nothing', () => {
    const result = runCli(
      ['my-app', '--non-interactive', '--dry-run', '--backend', 'express', '--database', 'neon'],
      tmpDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run complete');
    expect(fs.existsSync(path.join(tmpDir, 'my-app'))).toBe(false);
  });

  it('bare invocation (init alias) behaves identically', () => {
    const result = runCli(
      ['init', 'my-app', '--non-interactive', '--dry-run', '--backend', 'express'],
      tmpDir,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Dry run complete');
  });

  it('an incompatible selection exits 1 with a clear reason', () => {
    // frontend.zustand requires "frontend", which nothing here provides.
    const result = runCli(['my-app', '--non-interactive', '--dry-run', '--state', 'zustand'], tmpDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('requires');
  });
});

describe('create-graph-app --non-interactive (real write)', () => {
  it('refuses a non-empty target directory without --force', () => {
    const projectDir = path.join(tmpDir, 'occupied');
    fs.mkdirSync(projectDir);
    fs.writeFileSync(path.join(projectDir, 'existing.txt'), 'hi');

    const result = runCli(['occupied', '--non-interactive', '--no-install', '--backend', 'express'], tmpDir);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('not empty');
  });
});

describe('create-graph-app validate', () => {
  it('exits 0 for a valid project.config.yaml', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'project.config.yaml'),
      'project:\n  name: x\n  type: backend\nbackend:\n  framework: express\n',
    );
    const result = runCli(['validate'], tmpDir);
    expect(result.status).toBe(0);
  });

  it('exits 1 for a config referencing an incompatible combination', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'project.config.yaml'),
      'project:\n  name: x\n  type: frontend\nfrontend:\n  stateManagement: zustand\n',
    );
    const result = runCli(['validate'], tmpDir);
    expect(result.status).toBe(1);
  });

  it('accepts an explicit path argument', () => {
    const configPath = path.join(tmpDir, 'custom.yaml');
    fs.writeFileSync(configPath, 'project:\n  name: x\n  type: backend\nbackend:\n  framework: express\n');
    const result = runCli(['validate', 'custom.yaml'], tmpDir);
    expect(result.status).toBe(0);
  });
});
