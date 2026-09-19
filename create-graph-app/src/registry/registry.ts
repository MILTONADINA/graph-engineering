import { Template, TemplateCategory } from '../types';
import { loadTemplates } from './loader';

/**
 * Pure query surface over a fixed template list. No imports from src/cli,
 * src/generator, or Node's process/readline — this is what makes "the CLI is
 * a consumer, not the owner" true in code (see docs/architecture.md). A
 * future AI agent constructs this exact same class the exact same way.
 */
export class Registry {
  private readonly byId = new Map<string, Template>();

  constructor(templates: Template[]) {
    for (const template of templates) {
      this.byId.set(template.id, template);
    }
  }

  static load(dirs?: string[]): Registry {
    return new Registry(loadTemplates(dirs));
  }

  all(): Template[] {
    return [...this.byId.values()];
  }

  getById(id: string): Template | undefined {
    return this.byId.get(id);
  }

  requireById(id: string): Template {
    const template = this.getById(id);
    if (!template) {
      throw new Error(`Unknown template id: "${id}"`);
    }
    return template;
  }

  listByCategory(category: TemplateCategory): Template[] {
    return this.all().filter((template) => template.category === category);
  }

  /** "What templates provide X?" — e.g. listByProvides('state-management'). */
  listByProvides(capability: string): Template[] {
    return this.all().filter((template) => template.provides.includes(capability));
  }

  /** "What can work with this template?" — union of its own compatibleWith list
   * and anything else that declares compatibility back, since compatibility
   * isn't always declared symmetrically by template authors. */
  findCompatible(templateId: string): Template[] {
    const template = this.requireById(templateId);
    const ids = new Set(template.compatibleWith);
    for (const other of this.all()) {
      if (other.id !== templateId && other.compatibleWith.includes(templateId)) {
        ids.add(other.id);
      }
    }
    return [...ids].map((id) => this.getById(id)).filter((t): t is Template => Boolean(t));
  }

  /** Every template among `selectedIds` that conflicts with another among `selectedIds`. */
  findConflicts(selectedIds: string[]): Array<{ a: string; b: string }> {
    const conflicts: Array<{ a: string; b: string }> = [];
    const selectedSet = new Set(selectedIds);
    for (const id of selectedIds) {
      const template = this.getById(id);
      if (!template) continue;
      for (const conflictId of template.conflictsWith) {
        if (selectedSet.has(conflictId)) {
          conflicts.push({ a: id, b: conflictId });
        }
      }
    }
    return conflicts;
  }

  categories(): TemplateCategory[] {
    return [...new Set(this.all().map((template) => template.category))];
  }
}
