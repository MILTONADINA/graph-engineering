import { describe, expect, it } from 'vitest';
import { Registry } from '../src/registry/registry';
import { resolve } from '../src/resolver/dependency-resolver';
import { checkCompatibility } from '../src/resolver/compatibility';
import { resolvePackageVersion } from '../src/resolver/version';

const registry = Registry.load();

describe('resolver: dependency ordering', () => {
  it('backend.express is ordered before database.neon-postgres (requires backend)', () => {
    const plan = resolve(registry, ['database.neon-postgres', 'backend.express']);
    expect(plan.validation.valid).toBe(true);
    expect(plan.order.indexOf('backend.express')).toBeLessThan(plan.order.indexOf('database.neon-postgres'));
  });

  it('frontend.nextjs is ordered before frontend.zustand and frontend.shadcn', () => {
    const plan = resolve(registry, ['frontend.shadcn', 'frontend.zustand', 'frontend.nextjs']);
    expect(plan.validation.valid).toBe(true);
    const idx = (id: string) => plan.order.indexOf(id);
    expect(idx('frontend.nextjs')).toBeLessThan(idx('frontend.zustand'));
    expect(idx('frontend.nextjs')).toBeLessThan(idx('frontend.shadcn'));
  });

  it('all 6 MVP templates resolve together with no errors', () => {
    const plan = resolve(registry, [
      'frontend.nextjs',
      'frontend.zustand',
      'frontend.shadcn',
      'backend.express',
      'database.neon-postgres',
      'storage.aws-s3',
    ]);
    expect(plan.validation.valid).toBe(true);
    expect(plan.order).toHaveLength(6);
  });
});

describe('resolver: compatibility checks (brief §21/§37)', () => {
  it('reports an unmet requirement instead of silently adding the missing template', () => {
    // database.neon-postgres requires "backend", but no backend template is selected.
    const result = checkCompatibility(registry, ['database.neon-postgres']);
    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('unmet-requirement');
  });

  it('frontend.zustand alone (without frontend.nextjs) is an unmet requirement', () => {
    const result = checkCompatibility(registry, ['frontend.zustand']);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.code === 'unmet-requirement')).toBe(true);
  });

  it('never expands the selection to satisfy a requirement — resolve() returns exactly what was passed in on failure', () => {
    const plan = resolve(registry, ['database.neon-postgres']);
    expect(plan.validation.valid).toBe(false);
    expect(plan.templates.map((t) => t.id)).toEqual(['database.neon-postgres']);
  });
});

describe('resolver: version resolution', () => {
  it('picks the higher minor version when majors match', () => {
    const result = resolvePackageVersion('^1.2.0', '^1.5.0');
    expect(result.compatible).toBe(true);
    expect(result.chosen).toBe('^1.5.0');
  });

  it('reports incompatible when majors differ', () => {
    const result = resolvePackageVersion('^1.0.0', '^2.0.0');
    expect(result.compatible).toBe(false);
  });

  it('identical versions are trivially compatible', () => {
    const result = resolvePackageVersion('^3.1.0', '^3.1.0');
    expect(result).toEqual({ chosen: '^3.1.0', compatible: true });
  });
});
