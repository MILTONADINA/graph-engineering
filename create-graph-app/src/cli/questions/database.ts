import { Registry } from '../../registry/registry';
import { ProjectConfig } from '../../types';
import { selectOption, templatesToOptions } from '../prompt-helpers';

export async function askDatabase(registry: Registry, defaults: ProjectConfig): Promise<ProjectConfig['database']> {
  const options = templatesToOptions(registry.listByProvides('database'));
  const provider = await selectOption('Select your database:', options, defaults.database?.provider ?? 'none');
  return { provider: provider as NonNullable<ProjectConfig['database']>['provider'] };
}
