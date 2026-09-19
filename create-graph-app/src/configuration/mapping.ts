import { ProjectConfig } from '../types';

/**
 * The one place that knows "frontend.framework: nextjs" means the template
 * id "frontend.nextjs". Both the interactive wizard and the --config/flags
 * path go through this, so `project.config.yaml` round-trips exactly
 * (brief §10's reproducibility requirement) — there's no second mapping
 * anywhere else that could drift from this one.
 */
export function configToTemplateIds(config: ProjectConfig): string[] {
  const ids: string[] = [];

  if (config.frontend?.framework && config.frontend.framework !== 'none') {
    ids.push(`frontend.${config.frontend.framework}`);
  }
  if (config.frontend?.stateManagement && config.frontend.stateManagement !== 'none') {
    ids.push(`frontend.${config.frontend.stateManagement}`);
  }
  if (config.frontend?.ui && config.frontend.ui !== 'none' && config.frontend.ui !== 'tailwind') {
    ids.push(`frontend.${config.frontend.ui}`);
  }
  if (config.backend?.framework && config.backend.framework !== 'none') {
    ids.push(`backend.${config.backend.framework}`);
  }
  if (config.database?.provider && config.database.provider !== 'none') {
    ids.push(`database.${config.database.provider}`);
  }
  if (config.storage?.provider && config.storage.provider !== 'none') {
    ids.push(`storage.${config.storage.provider}`);
  }

  return ids;
}

/** Derives project.type from which categories are actually selected — used by defaults.ts and the wizard's initial project-type answer isn't overridden by this, but --non-interactive flag-only invocations use it to fill `project.type` when not explicitly given. */
export function inferProjectType(config: Pick<ProjectConfig, 'frontend' | 'backend'>): ProjectConfig['project']['type'] {
  const hasFrontend = Boolean(config.frontend?.framework && config.frontend.framework !== 'none');
  const hasBackend = Boolean(config.backend?.framework && config.backend.framework !== 'none');
  if (hasFrontend && hasBackend) return 'fullstack';
  if (hasBackend) return 'backend';
  return 'frontend';
}
