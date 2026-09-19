import { Registry } from '../../registry/registry';
import { ProjectConfig } from '../../types';
import { selectOption, templatesToOptions } from '../prompt-helpers';

/**
 * Options are built from the registry (`listByProvides`), not hardcoded —
 * this is the "template-aware" requirement (brief §3): adding a future
 * `frontend.remix` template that `provides: ["frontend"]` makes it appear
 * here automatically, no change to this file. "Tailwind only" is the one
 * fixed option with no template of its own — frontend.nextjs's own files
 * conditionally include base Tailwind config whenever `frontend.ui !==
 * 'none'`, and frontend.shadcn layers shadcn/ui's CLI-generated components
 * on top of that same Tailwind base. See templates/frontend/nextjs/template.yaml.
 */
export async function askFrontend(registry: Registry, defaults: ProjectConfig): Promise<ProjectConfig['frontend']> {
  const frameworkOptions = templatesToOptions(registry.listByProvides('frontend'));
  const framework = await selectOption('Select your frontend framework:', frameworkOptions, defaults.frontend?.framework ?? 'none');

  if (framework === 'none') {
    return { framework: 'none', stateManagement: 'none', ui: 'none' };
  }

  const stateOptions = templatesToOptions(registry.listByProvides('state-management'));
  const stateManagement = await selectOption('Select state management:', stateOptions, defaults.frontend?.stateManagement ?? 'none');

  const ui = await selectOption(
    'Select UI system:',
    [
      { value: 'shadcn', label: 'shadcn/ui' },
      { value: 'tailwind', label: 'Tailwind only' },
    ],
    defaults.frontend?.ui ?? 'none',
  );

  return {
    framework: framework as NonNullable<ProjectConfig['frontend']>['framework'],
    stateManagement: stateManagement as NonNullable<ProjectConfig['frontend']>['stateManagement'],
    ui: ui as NonNullable<ProjectConfig['frontend']>['ui'],
  };
}
