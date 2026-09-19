import { describe, expect, it } from 'vitest';
import { configFromFlags, NONE_CONFIG } from '../src/configuration';
import { configToTemplateIds, inferProjectType } from '../src/configuration/mapping';

describe('configFromFlags (brief §37: omitted flags must mean none, not a smart default)', () => {
  it('a bare --backend flag does not also select a frontend', () => {
    const config = configFromFlags({ backend: 'express' }, NONE_CONFIG);
    expect(configToTemplateIds(config)).toEqual(['backend.express']);
  });

  it('normalizes short aliases (neon -> neon-postgres, s3 -> aws-s3)', () => {
    const config = configFromFlags({ database: 'neon', storage: 's3' }, NONE_CONFIG);
    expect(config.database?.provider).toBe('neon-postgres');
    expect(config.storage?.provider).toBe('aws-s3');
  });

  it('rejects an invalid enum value', () => {
    expect(() => configFromFlags({ frontend: 'sveltekit' as any }, NONE_CONFIG)).toThrow();
  });

  it('the full brief §2 combination maps to all six template ids', () => {
    const config = configFromFlags(
      { frontend: 'nextjs', state: 'zustand', ui: 'shadcn', backend: 'express', database: 'neon', storage: 's3' },
      NONE_CONFIG,
    );
    expect(configToTemplateIds(config).sort()).toEqual(
      ['backend.express', 'database.neon-postgres', 'frontend.nextjs', 'frontend.shadcn', 'frontend.zustand', 'storage.aws-s3'].sort(),
    );
  });
});

describe('inferProjectType', () => {
  it('fullstack when both frontend and backend are selected', () => {
    expect(inferProjectType({ frontend: { framework: 'nextjs' }, backend: { framework: 'express' } })).toBe('fullstack');
  });
  it('backend when only backend is selected', () => {
    expect(inferProjectType({ frontend: { framework: 'none' }, backend: { framework: 'express' } })).toBe('backend');
  });
  it('frontend when only frontend is selected', () => {
    expect(inferProjectType({ frontend: { framework: 'nextjs' }, backend: { framework: 'none' } })).toBe('frontend');
  });
});
