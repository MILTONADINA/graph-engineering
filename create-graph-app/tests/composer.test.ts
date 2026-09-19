import { describe, expect, it } from 'vitest';
import { merge } from '../src/generator/composer';

describe('composer: gitignore-lines', () => {
  it('unions and deduplicates lines across contributors, grouped under a header comment', () => {
    const result = merge('gitignore-lines', [
      { templateId: 'a', content: 'node_modules/\n.env\n' },
      { templateId: 'b', content: '.env\ndist/\n' },
    ]);
    expect(result.content).toContain('# a');
    expect(result.content).toContain('# b');
    expect(result.content.match(/\.env$/gm)).toHaveLength(1); // deduplicated
    expect(result.content).toContain('node_modules/');
    expect(result.content).toContain('dist/');
  });
});

describe('composer: tsconfig-json', () => {
  it('merges compilerOptions and unions include arrays', () => {
    const result = merge('tsconfig-json', [
      { templateId: 'a', content: JSON.stringify({ compilerOptions: { strict: true }, include: ['src/**/*.ts'] }) },
      { templateId: 'b', content: JSON.stringify({ compilerOptions: { target: 'ES2020' }, include: ['tests/**/*.ts'] }) },
    ]);
    const parsed = JSON.parse(result.content);
    expect(parsed.compilerOptions).toEqual({ strict: true, target: 'ES2020' });
    expect(parsed.include.sort()).toEqual(['src/**/*.ts', 'tests/**/*.ts']);
    expect(result.conflicts).toEqual([]);
  });

  it('reports a conflict (and keeps the first value) when two contributors disagree on the same key', () => {
    const result = merge('tsconfig-json', [
      { templateId: 'a', content: JSON.stringify({ compilerOptions: { strict: true } }) },
      { templateId: 'b', content: JSON.stringify({ compilerOptions: { strict: false } }) },
    ]);
    const parsed = JSON.parse(result.content);
    expect(parsed.compilerOptions.strict).toBe(true);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0].code).toBe('tsconfig-conflict');
  });
});
