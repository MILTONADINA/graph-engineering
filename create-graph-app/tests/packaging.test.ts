import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Brief §30: an automated test confirming templates/schemas/docs/CLI are
 * actually in the published tarball — not just present in this checkout.
 * Delegates to scripts/check-pack-contents.js (also runnable standalone via
 * `npm run pack:check`) rather than duplicating the tar-listing logic here.
 * Requires a built dist/ (npm run build) — run after `npm run build`, which
 * `prepublishOnly` already sequences correctly.
 */
describe('npm packaging (brief §30)', () => {
  it('npm pack produces a tarball containing every required file', () => {
    const scriptPath = path.resolve(__dirname, '..', 'scripts', 'check-pack-contents.js');
    expect(() => execFileSync('node', [scriptPath], { stdio: 'pipe' })).not.toThrow();
  }, 30000);
});
