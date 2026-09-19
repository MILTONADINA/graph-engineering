export type TemplateCategory =
  | 'frontend'
  | 'backend'
  | 'database'
  | 'storage'
  | 'authentication'
  | 'authorization'
  | 'api'
  | 'testing'
  | 'devops';

export interface PackageRef {
  name: string;
  version: string;
  /** Same three-form condition syntax as FileOperation.when (see src/utils/render.ts). Omit for an always-installed dependency. */
  when?: string;
}

export interface EnvironmentVariable {
  name: string;
  required: boolean;
  secret: boolean;
  description?: string;
  default?: string;
}

export type FileOperationKind = 'copy' | 'create' | 'template' | 'append' | 'merge' | 'conditional';

export type MergeStrategyName = 'gitignore-lines' | 'tsconfig-json';

export interface FileOperation {
  op: FileOperationKind;
  src?: string;
  dest: string;
  content?: string;
  mergeStrategy?: MergeStrategyName;
  when?: string;
  then?: FileOperation[];
}

export type TargetApp = 'web' | 'api' | 'root';

export interface Template {
  id: string;
  name: string;
  version: string;
  category: TemplateCategory;
  description: string;
  requires: string[];
  provides: string[];
  compatibleWith: string[];
  conflictsWith: string[];
  dependencies: {
    dependencies: PackageRef[];
    devDependencies: PackageRef[];
  };
  scripts: Record<string, string>;
  environment: EnvironmentVariable[];
  files: FileOperation[];
  documentation?: string;
  targetApp: TargetApp;
  /** Absolute path to the template's own directory — set by the loader, not part of template.yaml. */
  dir: string;
}

export interface ProjectConfig {
  project: {
    name: string;
    type: 'fullstack' | 'backend' | 'frontend';
  };
  frontend?: {
    framework?: 'nextjs' | 'none';
    stateManagement?: 'zustand' | 'none';
    ui?: 'shadcn' | 'tailwind' | 'none';
  };
  backend?: {
    framework?: 'express' | 'none';
  };
  database?: {
    provider?: 'neon-postgres' | 'none';
  };
  storage?: {
    provider?: 'aws-s3' | 'none';
  };
}

export interface ValidationIssue {
  code: string;
  message: string;
  templateIds?: string[];
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

export interface ResolvedPlan {
  /** Selected template ids in dependency-safe generation order. */
  order: string[];
  templates: Template[];
  validation: ValidationResult;
}

export interface GenerateOptions {
  targetDir: string;
  dryRun: boolean;
  force: boolean;
  installDependencies: boolean;
}

export interface GeneratedFileRecord {
  templateId: string;
  path: string;
  op: FileOperationKind;
}

export interface GenerateResult {
  targetDir: string;
  files: GeneratedFileRecord[];
  dependenciesInstalled: boolean;
  environmentVariables: EnvironmentVariable[];
  documentationFiles: string[];
}
