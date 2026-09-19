import { Registry } from '../../registry/registry';
import { ProjectConfig } from '../../types';
import { selectOption, templatesToOptions } from '../prompt-helpers';

export async function askBackend(registry: Registry, defaults: ProjectConfig): Promise<ProjectConfig['backend']> {
  const options = templatesToOptions(registry.listByProvides('backend'));
  const framework = await selectOption('Select backend:', options, defaults.backend?.framework ?? 'none');
  return { framework: framework as NonNullable<ProjectConfig['backend']>['framework'] };
}
