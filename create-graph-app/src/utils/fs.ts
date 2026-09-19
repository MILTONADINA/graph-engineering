import * as fs from 'node:fs';
import * as path from 'node:path';
import { CliError } from './errors';

/**
 * Resolves `dest` against `root` and throws if the result would escape
 * `root` — the path-traversal guard docs/architecture.md's "Security
 * posture" section describes. Every write in file-generator.ts goes
 * through this first.
 */
export function resolveWithinRoot(root: string, dest: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, dest);
  if (resolved !== resolvedRoot && !resolved.startsWith(resolvedRoot + path.sep)) {
    throw new CliError(`Refusing to write outside the project directory: "${dest}"`, {
      reason: `The resolved path "${resolved}" is not inside "${resolvedRoot}".`,
      suggestion: 'This indicates a bug in a template\'s file operations (or a malicious custom template) — please report it.',
    });
  }
  return resolved;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeFileEnsuringDir(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, 'utf8');
}

export function readFileIfExists(filePath: string): string | undefined {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : undefined;
}

/** True if the directory doesn't exist, or exists and is empty. */
export function isUsableTargetDir(dir: string): boolean {
  if (!fs.existsSync(dir)) return true;
  const entries = fs.readdirSync(dir).filter((entry) => entry !== '.git' && entry !== '.DS_Store');
  return entries.length === 0;
}

export function listFilesRecursive(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFilesRecursive(full));
    } else {
      out.push(full);
    }
  }
  return out;
}
