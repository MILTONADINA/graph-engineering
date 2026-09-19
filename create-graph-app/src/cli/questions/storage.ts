import { Registry } from '../../registry/registry';
import { ProjectConfig } from '../../types';
import { selectOption, templatesToOptions } from '../prompt-helpers';

export async function askStorage(registry: Registry, defaults: ProjectConfig): Promise<ProjectConfig['storage']> {
  const options = templatesToOptions(registry.listByProvides('object-storage'));
  const provider = await selectOption('Select your file/object storage:', options, defaults.storage?.provider ?? 'none');
  return { provider: provider as NonNullable<ProjectConfig['storage']>['provider'] };
}
