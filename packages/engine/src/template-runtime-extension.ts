/** Compile-time registry contract. Only reviewed modules are registered by the engine. */
export interface TemplateArtifact {
  /** Canonical application-relative path, never prefixed by the renderer. */
  path: string;
  content: string;
  kind: "code" | "test";
  /** Exact existing content for a reviewed modification; omitted for new files. */
  before?: string;
}

export interface TemplateRenderContext {
  /** Cloned catalog-schema validated/defaulted inputs with derived entity identifiers. */
  inputs: Record<string, unknown>;
  readTarget(relative: string): Promise<string>;
  readAsset(relative: string): Promise<string>;
  /** Reads only the documented public .graph/manifest.json boundary. */
  readManifest(): Promise<string>;
  exportsIn(content: string): Set<string>;
  /** Available only for dependencies explicitly listed in the static extension. */
  renderDependency(
    templateId: string,
    inputs: Record<string, unknown>,
    overlay: ReadonlyMap<string, string>,
  ): Promise<TemplateRenderedArtifacts>;
}

export interface TemplateRenderedArtifacts {
  artifacts: TemplateArtifact[];
  outputs: {
    files: string[];
    exports?: string[];
    routes?: string[];
    tableExportName?: string;
    filterableFields?: string[];
    sortableFields?: string[];
    [key: string]: unknown;
  };
}

export interface AuditedTemplateExtension {
  directory: string;
  creates: { path: string; source: string }[];
  modifications?: Record<string, unknown>[];
  packages: string[];
  prerequisites?: Record<string, string[]>;
  composes?: string[];
  render(context: TemplateRenderContext): Promise<TemplateRenderedArtifacts>;
}
