import { Registry } from '../registry/registry';
import { ResolvedPlan, Template } from '../types';
import { checkCompatibility } from './compatibility';

/**
 * Resolves a user-selected template id set into a generation-ordered plan.
 * Deliberately does NOT auto-add any template the user didn't select, even
 * to satisfy a `requires` — an unmet requirement is a validation ERROR the
 * caller must surface and let the user fix by selecting the missing piece
 * themselves (brief §37: never silently pull in something unrequested).
 */
export function resolve(registry: Registry, selectedIds: string[]): ResolvedPlan {
  const validation = checkCompatibility(registry, selectedIds);
  const templates = selectedIds.map((id) => registry.requireById(id));

  const order = validation.valid ? topologicalOrder(templates) : selectedIds;

  return { order, templates, validation };
}

/**
 * Kahn's algorithm over "template A must generate before template B" edges,
 * where an edge exists whenever B `requires` a capability A `provides`.
 * Conceptually the same approach graph-templates/ai/architect-agent's
 * system-prompt.md describes for its own (much larger) node graph —
 * reimplemented here rather than imported, to keep this package's
 * dependency graph independent of graph-templates' runtime (see
 * docs/architecture.md "Resolver").
 */
function topologicalOrder(templates: Template[]): string[] {
  const byId = new Map(templates.map((template) => [template.id, template]));
  const providerOf = new Map<string, string[]>();
  for (const template of templates) {
    for (const capability of template.provides) {
      const providers = providerOf.get(capability) ?? [];
      providers.push(template.id);
      providerOf.set(capability, providers);
    }
  }

  const inDegree = new Map<string, number>();
  const edges = new Map<string, Set<string>>(); // providerId -> set of dependent ids
  for (const template of templates) {
    inDegree.set(template.id, 0);
    edges.set(template.id, new Set());
  }
  for (const template of templates) {
    for (const capability of template.requires) {
      for (const providerId of providerOf.get(capability) ?? []) {
        if (providerId === template.id) continue;
        const dependents = edges.get(providerId)!;
        if (!dependents.has(template.id)) {
          dependents.add(template.id);
          inDegree.set(template.id, (inDegree.get(template.id) ?? 0) + 1);
        }
      }
    }
  }

  const queue = templates.filter((template) => inDegree.get(template.id) === 0).map((template) => template.id);
  // Stable order for templates with no dependency relationship: category order
  // as originally selected, so output is deterministic and matches selection order.
  const result: string[] = [];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    for (const dependentId of edges.get(id) ?? []) {
      const remaining = (inDegree.get(dependentId) ?? 0) - 1;
      inDegree.set(dependentId, remaining);
      if (remaining === 0) {
        queue.push(dependentId);
      }
    }
  }

  if (result.length !== templates.length) {
    // A cycle would mean two templates require each other's capabilities —
    // not possible with the MVP template set, but fail loud rather than
    // silently drop templates if a future template introduces one.
    const missing = templates.map((t) => t.id).filter((id) => !visited.has(id));
    throw new Error(`Dependency cycle detected among templates: ${missing.join(', ')}`);
  }

  return result.filter((id) => byId.has(id));
}
