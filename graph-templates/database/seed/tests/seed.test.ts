import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

describe('database.seed', () => {
  it('generated seed.ts refuses to run in production', () => {
    const path = resolve(__dirname, '../../../../src/scripts/seed.ts');
    if (!existsSync(path)) return; // template repo itself has no generated project
    const contents = readFileSync(path, 'utf-8');
    expect(contents).toMatch(/NODE_ENV.*production/s);
  });
});
