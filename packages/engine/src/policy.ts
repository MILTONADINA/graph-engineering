import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import picomatch from "picomatch";
import type {
  ContextPacket,
  ProjectPolicy,
  ProviderConfig,
} from "@graph-engineering/contracts";

const protectedPaths = [
  ".git/**",
  ".git",
  "**/.git/**",
  "**/.git",
  ".graph/**",
  ".graph",
  "**/.graph/local/**",
  "**/.graph/local",
  "**/.graph/cache/**",
  "**/.graph/cache",
  "**/.graph/workspaces/**",
  "**/.graph/workspaces",
  "**/.graph/project.json",
  "**/.graph/providers.json",
  "**/.graph/decisions.json",
  "node_modules/**",
  "node_modules",
  "**/node_modules/**",
  "**/node_modules",
];
/**
 * Whether a path is inside the policy's working set: equal to or below one
 * of its entries. Without a working set, every path is.
 */
export function inWorkingSet(relative: string, policy: ProjectPolicy): boolean {
  return (
    !policy.workingSet ||
    policy.workingSet.some(
      (entry) => relative === entry || relative.startsWith(`${entry}/`),
    )
  );
}
/** Whether a directory contains, or is inside, part of the working set. */
export function reachesWorkingSet(
  directory: string,
  policy: ProjectPolicy,
): boolean {
  return (
    inWorkingSet(directory, policy) ||
    policy.workingSet!.some((entry) => entry.startsWith(`${directory}/`))
  );
}
/**
 * The policy without its working set, for work that covers the whole
 * repository: verification, the run workspace copy, fingerprints and
 * publication. Exclusions and protected paths still apply.
 */
export function wholeRepository(policy: ProjectPolicy): ProjectPolicy {
  if (!policy.workingSet) return policy;
  const { workingSet: _workingSet, ...rest } = policy;
  return rest;
}
export function isAllowedPath(
  relative: string,
  policy: ProjectPolicy,
  forExport = false,
): boolean {
  // Policy matching and filesystem resolution must see exactly the same path.
  // In particular, picomatch does not normalize `./` but path.resolve does.
  const clean = relative;
  if (
    !clean ||
    clean.includes("\\") ||
    clean.includes("\0") ||
    clean.includes(":") ||
    clean.startsWith("/") ||
    clean
      .split("/")
      .some(
        (s) =>
          s === "." ||
          s === ".." ||
          s === "" ||
          /[. ]$/.test(s) ||
          /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(s),
      )
  )
    return false;
  // Conservatively protect aliases even on case-sensitive machines; projects
  // routinely move to default case-insensitive macOS/Windows filesystems.
  const segments = clean.split("/");
  // This locally generated deployment request carries account, IAM, VPC and
  // secret-reference ARNs. A broad exportPaths allowlist must not expose it.
  // Keep it writable/readable for local proposals and verification.
  if (
    forExport &&
    segments.length >= 2 &&
    segments.at(-2)?.toLowerCase() === "deploy" &&
    segments.at(-1)?.toLowerCase() === "ecs-express-create-service.json"
  )
    return false;
  const prefixes = segments.map((_, index) =>
    segments.slice(0, index + 1).join("/"),
  );
  // Only these exact public artifacts can cross the root .graph boundary. The
  // ledger additionally requires owner policy opt-in; it is never engine state.
  // All explicit exclusions and independent cloud-export rules still apply.
  const publicContext =
    clean === ".graph/CONTEXT.md" ||
    (clean === ".graph/manifest.json" &&
      policy.allowPublicTemplateLedger === true);
  if (!publicContext && !inWorkingSet(clean, policy)) return false;
  if (
    protectedPaths.some(
      (pattern) =>
        !(publicContext && [".graph/**", ".graph"].includes(pattern)) &&
        prefixes.some((prefix) =>
          picomatch(pattern, { dot: true, nocase: true })(prefix),
        ),
    ) ||
    policy.excludedPaths.some((pattern) =>
      prefixes.some((prefix) =>
        picomatch(pattern, {
          dot: true,
          nocase: true,
          basename: !pattern.includes("/"),
        })(prefix),
      ),
    )
  )
    return false;
  return (
    !forExport ||
    (policy.exportPaths.length > 0 &&
      picomatch(policy.exportPaths, { dot: true })(clean))
  );
}
export async function safePath(
  root: string,
  relative: string,
  policy: ProjectPolicy,
): Promise<string> {
  if (!isAllowedPath(relative, policy))
    throw new Error(`Path is outside allowed project scope: ${relative}`);
  const base = await realpath(root);
  const target = path.resolve(base, relative);
  const rel = path.relative(base, target);
  if (rel.startsWith("..") || path.isAbsolute(rel))
    throw new Error("Path escapes workspace");
  let current = base;
  for (const part of rel.split(path.sep)) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new Error(`Symlink is outside managed file scope: ${relative}`);
      const canonical = path
        .relative(base, await realpath(current))
        .split(path.sep)
        .join("/");
      if (
        !isAllowedPath(canonical, policy) &&
        !(
          canonical === ".graph" &&
          (relative === ".graph/CONTEXT.md" ||
            (relative === ".graph/manifest.json" &&
              policy.allowPublicTemplateLedger === true))
        )
      )
        throw new Error(
          `Resolved path is outside allowed project scope: ${relative}`,
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return target;
}
// Keep key recognition and value redaction on the same assignment grammar.
// Quoted object keys, env names and camelCase source identifiers are common
// ways for a credential to appear in otherwise exportable source files.
const assignedCredential =
  /(?<![A-Za-z0-9_$])(["'`]?)([A-Za-z_][A-Za-z0-9_-]{0,127})\1\s*[:=]\s*(["'`]?)(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)([A-Za-z0-9+/_-]{16,}={0,2})(?![A-Za-z0-9_$.(?=])/gi;
const credentialName = (name: string): boolean =>
  /(?:^|[_-])(?:password|api[_-]?key|secret|access[_-]?(?:token|key)|token|private[_-]?key)(?:[_-](?:key|value))?$/i.test(
    name,
  ) ||
  /(?:Password|ApiKey|Secret|AccessToken|AccessKey|Token|PrivateKey)(?:Key|Value)?$/.test(
    name,
  );
function hasAssignedCredential(text: string): boolean {
  for (const match of text.matchAll(assignedCredential))
    if (credentialName(match[2]!)) return true;
  return false;
}

const knownKey =
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b/i;
const namedToken =
  /\b[A-Z][A-Z0-9_]*_TOKEN\s*[:=]\s*["']?(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)[A-Za-z0-9+/_-]{16,}={0,2}/;
const bearerHeader =
  /\bauthorization\s*:\s*bearer\s+(?!<|example|placeholder|your[-_]|test[-_])[A-Za-z0-9._~+/-]{16,}={0,2}(?=\s|$|["'])/i;
export function containsSecret(text: string): boolean {
  return (
    knownKey.test(text) ||
    hasAssignedCredential(text) ||
    namedToken.test(text) ||
    bearerHeader.test(text)
  );
}
const privateKeyFooter = /-----END [^-]*PRIVATE KEY-----/gi;
// The same detectors as containsSecret, counted per finding; the map is
// non-empty exactly when containsSecret(text) is true. Detectors can match
// only part of a credential (a key header, a token cut at "."), so a finding
// is the detector plus the whole lines the match touches, and a private key
// header extends through its END marker. Line and footer lookups are shared
// across matches so long minified lines stay linear.
export function secretFindings(text: string): Map<string, number> {
  const newlines: number[] = [];
  for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1))
    newlines.push(at);
  const firstNewlineAtOrAfter = (offset: number) => {
    let low = 0;
    let high = newlines.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (newlines[middle]! < offset) low = middle + 1;
      else high = middle;
    }
    return low;
  };
  const ranges = new Map<string, number>();
  const add = (detector: string, start: number, end: number) => {
    const previous = firstNewlineAtOrAfter(start) - 1;
    const next = firstNewlineAtOrAfter(end);
    const lineStart = previous < 0 ? 0 : newlines[previous]! + 1;
    const lineEnd = next < newlines.length ? newlines[next]! : text.length;
    const range = `${detector}:${lineStart}:${lineEnd}`;
    ranges.set(range, (ranges.get(range) ?? 0) + 1);
  };
  // The first footer starting at or after `searchedFrom` answers every later
  // offset up to that footer's start, and a failed search answers all later
  // offsets.
  let searchedFrom = -1;
  let footer: RegExpExecArray | null = null;
  const footerEnd = (offset: number) => {
    if (
      searchedFrom === -1 ||
      offset < searchedFrom ||
      (footer && footer.index < offset)
    ) {
      privateKeyFooter.lastIndex = offset;
      footer = privateKeyFooter.exec(text);
      searchedFrom = offset;
    }
    return footer ? footer.index + footer[0].length : undefined;
  };
  for (const [detector, pattern] of [
    ["key", knownKey],
    ["token", namedToken],
    ["bearer", bearerHeader],
  ] as const)
    for (const match of text.matchAll(
      new RegExp(pattern.source, `${pattern.flags}g`),
    )) {
      let end = match.index + match[0].length;
      if (/^-----BEGIN/i.test(match[0])) end = footerEnd(end) ?? end;
      add(detector, match.index, end);
    }
  for (const match of text.matchAll(assignedCredential))
    if (credentialName(match[2]!))
      add("assigned", match.index, match.index + match[0].length);
  const findings = new Map<string, number>();
  for (const [range, count] of ranges) {
    const [detector, start, end] = range.split(":");
    const finding = `${detector}\0${text.slice(Number(start), Number(end))}`;
    findings.set(finding, (findings.get(finding) ?? 0) + count);
  }
  return findings;
}
// True when `after` has a secret finding that `before` lacks, or has more
// copies of one, so an edit is judged by what it adds rather than by
// fixtures already in the file. A finding whose lines changed counts as added.
export function introducesSecret(before: string, after: string): boolean {
  const existing = secretFindings(before);
  for (const [finding, count] of secretFindings(after))
    if ((existing.get(finding) ?? 0) < count) return true;
  return false;
}
export function redact(text: string): string {
  return text
    .replace(
      assignedCredential,
      (match, _quote, name: string, _valueQuote, value: string) =>
        credentialName(name)
          ? `${match.slice(0, -value.length)}[REDACTED]`
          : match,
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      "[REDACTED PRIVATE KEY]",
    )
    .replace(
      /\b(?:sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16})\b/g,
      "[REDACTED]",
    )
    .replace(
      /((?:password|api[_-]?key|secret|access[_-]?token)\s*[:=]\s*)["']?[^\s"']{12,}["']?/gi,
      "$1[REDACTED]",
    )
    .replace(
      /(\b[A-Z][A-Z0-9_]*_TOKEN\s*[:=]\s*)["']?[A-Za-z0-9+/_-]{16,}={0,2}["']?/g,
      "$1[REDACTED]",
    )
    .replace(
      /(\bauthorization\s*:\s*bearer\s+)[A-Za-z0-9._~+/-]{16,}={0,2}/gi,
      "$1[REDACTED]",
    );
}
export function assertEndpoint(
  endpoint: string,
  policy: ProjectPolicy,
  localOnly = false,
): URL {
  const url = new URL(endpoint);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.username || url.password)
    throw new Error("Credentials in endpoint URLs are prohibited");
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("Unsupported endpoint protocol");
  if (localOnly && !loopback)
    throw new Error("Local providers must use loopback endpoints");
  if (
    !loopback &&
    (policy.inference === "local" ||
      policy.network === "deny" ||
      url.protocol !== "https:" ||
      !policy.allowedHosts.includes(url.hostname))
  )
    throw new Error(`Project policy denies endpoint ${url.hostname}`);
  return url;
}
export function assertProvider(
  provider: ProviderConfig,
  policy: ProjectPolicy,
  effort?: string,
): void {
  if (!policy.providers.includes(provider.id))
    throw new Error(`Project policy does not allow provider ${provider.id}`);
  if (
    provider.kind !== "local" &&
    (policy.inference === "local" || policy.network === "deny")
  )
    throw new Error(
      "Offline policy excludes cloud and installed-agent workers",
    );
  if (effort && !(provider.efforts ?? []).includes(effort))
    throw new Error(`Unsupported effort ${effort} for ${provider.id}`);
  if (provider.kind === "local")
    assertEndpoint(
      provider.endpoint ?? "http://127.0.0.1:11434/v1",
      policy,
      true,
    );
  else if (provider.kind === "openai")
    assertEndpoint(provider.endpoint ?? "https://api.openai.com/v1", policy);
  else if (provider.kind === "anthropic")
    assertEndpoint(provider.endpoint ?? "https://api.anthropic.com", policy);
  if (
    policy.maxCostUsd !== null &&
    (!["openai", "anthropic", "local"].includes(provider.kind) ||
      provider.inputCostPerMillion === undefined ||
      provider.outputCostPerMillion === undefined)
  )
    throw new Error(
      "This provider cannot support the configured cost budget; configure pricing or use a metered API worker",
    );
}
/**
 * Gate for memory-derived mandatory context leaving for a cloud consumer.
 * Missing provenance, private or out-of-policy memory, and any text an
 * operator has not authorized for export reject the whole packet; mandatory
 * text is never dropped to make an export succeed. With attributedOnly, every
 * mandatory string must come from memory (no caller-supplied acceptance text).
 */
export function assertMandatoryExport(
  packet: ContextPacket,
  policy: ProjectPolicy,
  options: { attributedOnly: boolean },
): void {
  const entries = packet.mandatorySources;
  if (!entries)
    throw new Error(
      "Mandatory context has no memory provenance; cloud export is refused",
    );
  if (
    entries.some(
      (entry) =>
        entry.visibility !== "shared" ||
        entry.sources.length === 0 ||
        entry.sources.some(
          (source) =>
            !isAllowedPath(source.path, policy, true) ||
            containsSecret(source.path),
        ),
    )
  )
    throw new Error(
      "Mandatory memory is not exportable to this client; use a local worker or share eligible knowledge",
    );
  if (
    entries.some(
      (entry) =>
        entry.exportAuthorized !== true ||
        entry.textSha256 !==
          createHash("sha256").update(entry.text).digest("hex"),
    )
  )
    throw new Error(
      "Mandatory memory has not been authorized for export to this client",
    );
  const attributed = new Set(entries.map((entry) => entry.text));
  if (
    options.attributedOnly &&
    packet.mandatory.some((text) => !attributed.has(text))
  )
    throw new Error(
      "Mandatory context has no memory provenance; cloud export is refused",
    );
}
/** How a worker learns which requested sources did not fit its budget. */
export const NOT_INCLUDED_WARNING =
  "Not included, because the context budget is full: ";
export function contextForProvider(
  packet: ContextPacket,
  provider: ProviderConfig,
  policy: ProjectPolicy,
): ContextPacket {
  assertProvider(provider, policy);
  if (provider.kind === "local") return packet;
  if (containsSecret(packet.query) || packet.mandatory.some(containsSecret))
    throw new Error("Task or mandatory context contains a potential secret");
  // Worker packets also carry the plan's acceptance criteria as mandatory text.
  assertMandatoryExport(packet, policy, { attributedOnly: false });
  return {
    ...packet,
    items: packet.items.filter(
      (item) =>
        item.source &&
        isAllowedPath(item.source.path, policy, true) &&
        !containsSecret(item.text),
    ),
    // Local diagnostics can contain non-exportable filenames, parser excerpts,
    // or native-loader paths. Do not forward free-form coverage metadata.
    coverage: {
      semantic: packet.coverage.semantic,
      graph:
        "Syntax-based relationships; limited to explicitly exportable files.",
      warnings: [
        "Cloud packet includes only explicitly exportable source-backed items.",
        "Local indexing diagnostics are not exported.",
        "Token counts remain conservative estimates, not provider-reported usage.",
        // Names only files the worker requested, which were checked as
        // exportable before this note was written.
        ...packet.coverage.warnings.filter((warning) =>
          warning.startsWith(NOT_INCLUDED_WARNING),
        ),
      ],
    },
  };
}
export function assertPublication(
  policy: ProjectPolicy,
  branch: string,
  remoteHost = "github.com",
): void {
  if (
    /(?:^|\/)(?:main|master)$/.test(branch) ||
    branch.startsWith("-") ||
    !/^[a-zA-Z0-9_./-]+$/.test(branch)
  )
    throw new Error(
      "Publishing to main/master or an invalid branch is prohibited",
    );
  if (policy.publication === "none") throw new Error("Publication is disabled");
  if (
    policy.publication === "draft-pr" &&
    (policy.network === "deny" || !policy.allowedHosts.includes(remoteHost))
  )
    throw new Error("Project policy denies GitHub publication");
}
