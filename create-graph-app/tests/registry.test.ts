import { describe, expect, it } from 'vitest';
import { Registry } from '../src/registry/registry';
import { loadTemplates } from '../src/registry/loader';

describe('registry', () => {
  it('discovers all 6 MVP templates from the bundled templates/ directory', () => {
    const registry = Registry.load();
    const ids = registry.all().map((t) => t.id).sort();
    expect(ids).toEqual([
      'backend.express',
      'database.neon-postgres',
      'frontend.nextjs',
      'frontend.shadcn',
      'frontend.zustand',
      'storage.aws-s3',
    ]);
  });

  it('every loaded template validates against template.schema.json (loader throws otherwise)', () => {
    expect(() => loadTemplates()).not.toThrow();
  });

  it('listByProvides finds templates by capability, not by hardcoded id', () => {
    const registry = Registry.load();
    const stateManagement = registry.listByProvides('state-management');
    expect(stateManagement.map((t) => t.id)).toEqual(['frontend.zustand']);
  });

  it('listByCategory groups correctly', () => {
    const registry = Registry.load();
    expect(registry.listByCategory('frontend').map((t) => t.id).sort()).toEqual([
      'frontend.nextjs',
      'frontend.shadcn',
      'frontend.zustand',
    ]);
  });

  it('findCompatible returns declared compatibleWith entries', () => {
    const registry = Registry.load();
    const compatible = registry.findCompatible('frontend.nextjs').map((t) => t.id);
    expect(compatible).toContain('frontend.zustand');
    expect(compatible).toContain('frontend.shadcn');
  });

  it('findConflicts returns empty for the MVP set (nothing conflicts today)', () => {
    const registry = Registry.load();
    const ids = registry.all().map((t) => t.id);
    expect(registry.findConflicts(ids)).toEqual([]);
  });

  it('getById returns undefined for an unknown id, requireById throws', () => {
    const registry = Registry.load();
    expect(registry.getById('nope.nope')).toBeUndefined();
    expect(() => registry.requireById('nope.nope')).toThrow();
  });
});
