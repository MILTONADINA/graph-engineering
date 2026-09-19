import { describe, expect, it } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

describe('database.migrations', () => {
  it('src/migrations/README.md exists in a generated project', () => {
    const path = resolve(__dirname, '../../../../src/migrations/README.md');
    expect(existsSync(path)).toBe(true);
  });
});
