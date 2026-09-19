import * as clack from '@clack/prompts';
import { ProjectConfig } from '../../types';
import { promptOrExit } from '../prompt-helpers';

export function validateProjectName(name: string): string | undefined {
  if (!name || name.trim().length === 0) return 'Project name is required.';
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    return 'Use lowercase letters, numbers, and dashes only (npm package naming convention), starting with a letter or number.';
  }
  return undefined;
}

export async function askProject(defaults: ProjectConfig, initialName?: string): Promise<ProjectConfig['project']> {
  const name = initialName ?? (await promptOrExit(
    clack.text({
      message: 'What is your project name?',
      placeholder: defaults.project.name,
      initialValue: defaults.project.name,
      validate: validateProjectName,
    }),
  ));

  const type = await promptOrExit(
    clack.select({
      message: 'What type of project do you want to create?',
      initialValue: defaults.project.type,
      options: [
        { value: 'fullstack', label: 'Full-stack web application' },
        { value: 'backend', label: 'Backend API' },
        { value: 'frontend', label: 'Frontend application' },
      ],
    }),
  );

  return { name, type };
}
