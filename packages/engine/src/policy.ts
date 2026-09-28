import { createHash } from "node:crypto";
import path from "node:path";
import { lstat, readdir, realpath } from "node:fs/promises";
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
/**
 * Whether a glob list entry is a usable exclusion or inclusion: `!` alone,
 * `!!` double negation and empty entries have no clear meaning.
 */
export function validGlobEntry(pattern: string): boolean {
  return pattern.length > 0 && pattern !== "!" && !pattern.startsWith("!!");
}
/**
 * Compiles an allowlist of globs such as `exportPaths` or a step's `writes`.
 * A `!pattern` entry is an exclusion: a path matches when some positive entry
 * matches it and no exclusion does. picomatch's own list semantics would
 * treat `!pattern` as "everything outside pattern" and so widen the list.
 * A list with no positive entry, or with an invalid entry, matches nothing.
 *
 * Each side errs toward matching less. Patterns and paths are compared in
 * Unicode NFC, so an exclusion typed as `café` also covers a file stored as
 * decomposed `café` (common on macOS). Exclusions ignore case, as a
 * case-insensitive file system does, and a slash-free exclusion such as
 * `!*.pem` applies at any depth, like `excludedPaths`. Inclusions stay
 * case-sensitive, and a slash-free inclusion still means the top level only.
 */
export function globAllowlist(
  patterns: readonly string[],
): (relative: string) => boolean {
  if (!patterns.every(validGlobEntry)) return () => false;
  const nfc = (text: string) => text.normalize("NFC");
  const include = patterns
    .filter((pattern) => !pattern.startsWith("!"))
    .map(nfc);
  const exclude = patterns
    .filter((pattern) => pattern.startsWith("!"))
    .map((pattern) => nfc(pattern.slice(1)));
  if (!include.length) return () => false;
  const included = picomatch(include, { dot: true, nonegate: true });
  const excluded = exclude.map((pattern) =>
    picomatch(pattern, {
      dot: true,
      nonegate: true,
      nocase: true,
      basename: !pattern.includes("/"),
    }),
  );
  return (relative) => {
    const candidate = nfc(relative);
    return (
      included(candidate) && !excluded.some((matches) => matches(candidate))
    );
  };
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
  // Exclusions compare in Unicode NFC, so a decomposed file name cannot
  // slip past an exclusion typed in the usual composed form.
  const nfcSegments = clean.normalize("NFC").split("/");
  const prefixes = nfcSegments.map((_, index) =>
    nfcSegments.slice(0, index + 1).join("/"),
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
        picomatch(pattern.normalize("NFC"), {
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
    (policy.exportPaths.length > 0 && globAllowlist(policy.exportPaths)(clean))
  );
}
/**
 * Resolves a policy-checked project path. With forExport, the path must also
 * be exportable, and every existing segment must have exactly that name on
 * disk: on a case-insensitive file system `notes/plan.md` would otherwise
 * open `notes/plan.MD`, a file the export rules never matched. The name
 * comparison is exact in case but not in Unicode form (a file stored
 * decomposed is still found by its composed name), and the file's own name
 * on disk must be exportable too.
 */
export async function safePath(
  root: string,
  relative: string,
  policy: ProjectPolicy,
  options: { forExport?: boolean } = {},
): Promise<string> {
  if (!isAllowedPath(relative, policy, options.forExport === true))
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
      if (options.forExport) {
        const wanted = part.normalize("NFC");
        const onDisk = (await readdir(path.dirname(current))).find(
          (entry) => entry.normalize("NFC") === wanted,
        );
        if (onDisk === undefined)
          throw new Error(
            `Path differs from the file's name on disk, so it is not exported: ${relative}`,
          );
        if (
          current === target &&
          !isAllowedPath(
            path
              .relative(base, path.join(path.dirname(current), onDisk))
              .split(path.sep)
              .join("/"),
            policy,
            true,
          )
        )
          throw new Error(
            `The file's name on disk is not exportable: ${relative}`,
          );
      }
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
// Template values ($VAR, ${VAR}, $(VAR), {name}, {{name}}, #{name}, <name>,
// [NAME], %(name)s, %{name}, %NAME%) and masked ones (****, ...) are not
// credentials, but only when the whole value has that shape: a value that
// merely begins with $, {, <, *, . or % is not exempted here.
const templateOrMask = (value: string): boolean =>
  /^(?:\$(?:\{[^{}]*\}|\([A-Za-z_]\w*\)|[A-Za-z_]\w*)|\$?\{\{[^{}]*\}\}|#?\{[^{}]*\}|<[^<>]*>|\[[^[\]]*\]|%(?:\([^()]*\)s|\{[^{}]*\}|\w+%)|(.)\1*)$/.test(
    value,
  );
// A value made only of placeholder words (password, yourpassword,
// passwordpassword), optionally followed by digits (password123) or by a
// separator and anything (SECRET_CANARY, your-password-here), is a fixture or
// an example. A placeholder word that merely begins a value
// (Password2024Summer, secretS3cureProdPw, testimony9Kq2Lm) does not exempt it.
const placeholderPassword =
  /^(?:pass(?:word)?|pwd|secret|credential|example|placeholder|changeme|your|test|dummy|fake|sample|redacted|fixture|xxx)+(?:[_-]|\d*$)/i;
// Whole-value templates, masks, placeholder words, interpolations and URLs
// are not credential values.
const inertValue = (value: string): boolean =>
  /\$\{|:\/\//.test(value) ||
  templateOrMask(value) ||
  placeholderPassword.test(value);
// Keep key recognition, detection and value redaction on one assignment
// grammar. Quoted object keys, env names and camelCase source identifiers are
// common ways for a credential to appear in otherwise exportable source
// files. The value is one of: 16 or more token characters (group 5, as
// before, not starting with a placeholder word); a quoted value of 12 to 256
// characters with no whitespace or quote (group 6); or an unquoted one on the
// same line that ends at whitespace, a quote, an escaped newline, tab or
// quote (as in "KEY=value\n" inside a string) or the end of the text, less
// one trailing ";" or "," (group 7). The last two are tried only after a name
// ending like a credential's, and their lengths are bounded, so long runs of
// other assignments without whitespace stay linear. The whitespace after
// [:=] is taken whole ((?=\S)): no value starts with whitespace, and giving
// it back one character at a time would rescan the run in both lookbehinds
// on every step, which is quadratic in the run's length.
const assignedCredential =
  /(?<![A-Za-z0-9_$])(["'`]?)([A-Za-z_][A-Za-z0-9_-]{0,127})\1\s*([:=])\s*(?=\S)(["'`]?)(?:(?!\$\{|process\.env|os\.environ|example|placeholder|your[-_]|test[-_]|undefined|null)([A-Za-z0-9+/_-]{16,}={0,2})(?![A-Za-z0-9_$.(?=])|(?<=(?:password|api[_-]?key|secret|access[_-]?(?:token|key)|token|private[_-]?key)(?:[_-]?(?:key|value))?["'`]?\s*[:=]\s*["'`]?)(?:(?<=["'`])([^\s"'`]{12,256})(?=\4)|(?<=[:=][ \t]*)((?:[^\s"'`\\]|\\[^\snrt"'`]){11,255}[^\s"'`;,\\])(?=[;,]?(?:[\s"'`]|\\[nrt"'`]|$))))/gi;
const credentialName = (name: string): boolean =>
  /(?:^|[_-])(?:password|api[_-]?key|secret|access[_-]?(?:token|key)|token|private[_-]?key)(?:[_-](?:key|value))?$/i.test(
    name,
  ) ||
  /(?:Password|ApiKey|Secret|AccessToken|AccessKey|Token|PrivateKey)(?:Key|Value)?$/.test(
    name,
  );
// A word that goes from digits back to letters twice (Lm2Vx9Kp4R), as a
// generated password does and an identifier, key or number rarely does. Hex
// (a UUID, hash or 0x1f2e3d literal) has no letter past F, so it is not one.
const generatedWord = (value: string): boolean =>
  (value.match(/[A-Za-z0-9]+/g) ?? []).some(
    (word) => /[G-Zg-z]/.test(word) && /\d[A-Za-z]+\d+[A-Za-z]/.test(word),
  );
// A quoted key path (auth.refreshToken, errors:invalid_token, keys/app.pem)
// or sigil name (?NoLineTerminatorHere, @scope/name, $auth.token) names a
// setting, not a password. A "$" inside a word (Welcome$2024x) is not part of
// a key path.
const keyPath = /^[?@#:.$]?[A-Za-z_][\w-]*(?:(?:\.|::?|\/)[A-Za-z_][\w-]*)*$/;
// An unquoted value that reads as code: a regular expression literal; one
// that starts with a comparison, arrow, negation or bracket (token=;,
// token=!0, token=(a), token=[a]); a word or member chain that ends there or
// goes on into a call, index, type argument, ternary, statement end, list,
// assignment, concatenation, comparison or logical operator; or a member
// chain with a non-null assertion (process.env.SECRET!). Apart from a regular
// expression, a value holding what code does not, a "#" other than a private
// member's, an "@" or a generated word, is not code.
const codeValue = (value: string): boolean =>
  /^\/(?![*/]).*\/[dgimsuyv]*$/.test(value) ||
  (!/(?<!\.)#|@/.test(value) &&
    !generatedWord(value) &&
    /^[=>;,!()[\]{}]|^[\w$]+(?:(?:\??\.|::|->)#?[A-Za-z_$][\w$]*)*(?:$|[([<{?;,)\]}=+]|!=|&&|\|\|)|^[\w$]+(?:(?:\??\.|::|->)#?[A-Za-z_$][\w$]*)+!(?![\w$])/.test(
      value,
    ));
// A punctuated unquoted value after ":" is YAML-like only on a line of its
// own: indentation, an optional list dash and dotted key prefix before it, and
// nothing but an optional comment after it. Both looks are bounded so a long
// line stays linear.
function ownLine(text: string, start: number, end: number): boolean {
  const before = text.slice(Math.max(0, start - 256), start);
  const lineStart = before.lastIndexOf("\n") + 1;
  if (lineStart === 0 && start > 256) return false;
  const after = /[ \t]*(?:\r?\n|$|#)/y;
  after.lastIndex = end;
  return (
    /^[ \t]*(?:-[ \t]+)?(?:[\w-]+\.)*$/.test(before.slice(lineStart)) &&
    after.test(text)
  );
}
// Whether an assignment match is a credential: its name is a credential's and
// its value is one. Values with punctuation are judged like URL passwords:
// templates, masks and placeholder words are not credentials, and neither are
// interpolations, URLs, quoted key paths without a generated word, and
// unquoted code.
function credentialAssignment(text: string, match: RegExpExecArray): boolean {
  if (!credentialName(match[2]!)) return false;
  if (match[5] !== undefined) return true;
  const quoted = match[6];
  const value = (quoted ?? match[7])!;
  if (!/[^A-Za-z0-9+/_-]/.test(value) || inertValue(value)) return false;
  if (quoted !== undefined) return !keyPath.test(value) || generatedWord(value);
  return (
    !codeValue(value) &&
    (match[3] === "=" ||
      ownLine(text, match.index, match.index + match[0].length))
  );
}
// Detection, findings and redaction all read assignments here. A token value
// cut short by punctuation ("sixteencharprefix!rest") extends through the rest
// of its run, so redaction removes all of it. A rejected match resumes inside
// its value, so a value that runs over a later assignment
// (user=bob&password=...) does not hide it.
function* assignedCredentials(
  text: string,
): Generator<{ start: number; valueStart: number; end: number }> {
  const pattern = new RegExp(assignedCredential);
  const rest = /[^\s"'`]{0,256}/y;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    let end = match.index + match[0].length;
    const valueStart = end - (match[5] ?? match[6] ?? match[7])!.length;
    if (!credentialAssignment(text, match)) {
      pattern.lastIndex = valueStart;
      continue;
    }
    if (match[5] !== undefined) {
      rest.lastIndex = end;
      end += rest.exec(text)![0].length;
      pattern.lastIndex = end;
    }
    yield { start: match.index, valueStart, end };
  }
}
function hasAssignedCredential(text: string): boolean {
  return !assignedCredentials(text).next().done;
}

// Every PEM private-key label: PKCS#1 (RSA), SEC1 (EC), DSA, OpenSSH, PKCS#8
// (plain and ENCRYPTED) and OpenPGP's PRIVATE KEY BLOCK. Detection, the END
// marker search and redaction share it, so they agree on what a key is.
const privateKeyLabel = String.raw`(?:[A-Z0-9.]+ )*PRIVATE KEY(?: BLOCK)?`;
// AWS access key IDs, sk- API keys and GitHub tokens, in any letter case.
// Detection and redaction are both built from this one source.
const apiKey = String.raw`\b(?:(?:AKIA|ASIA)[0-9A-Z]{16}|sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{30,})\b`;
const knownKey = new RegExp(
  String.raw`-----BEGIN ${privateKeyLabel}-----|${apiKey}`,
  "i",
);
// Live vendor keys recognized by their fixed, case-sensitive prefixes: Stripe
// secret and restricted keys, Slack tokens and Google API keys. A value with
// a run of one repeated character (sk_live_xxxx…) or one starting with a
// placeholder word (xoxb-your-token) is documentation, not a key.
const liveToken =
  /\b(?:[rs]k_live_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{20,}|AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-]))/g;
const placeholderToken = (token: string): boolean =>
  /([A-Za-z0-9])\1{5}/i.test(token) ||
  /^(?:[rs]k_live_|xox[abprs]-|AIza)(?:example|placeholder|your|dummy|fake|sample|test)/i.test(
    token,
  );
function liveTokens(text: string): RegExpExecArray[] {
  return [...text.matchAll(liveToken)].filter(
    (match) => !placeholderToken(match[0]),
  );
}
// A password in a URL's userinfo (scheme://user:password@host). Group 1 is
// everything before the password, so redaction keeps the scheme, user and
// host. Like a WHATWG URL parser, the last "@" before the path ends the
// userinfo, so an unencoded "@" stays in the password. Lengths are bounded
// so a long run of scheme-like text or of "@" stays linear.
const urlCredential =
  /\b([A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/([^\s:/?#@[\]"'`<>]{0,256}):)([^\s/?#[\]"'`<>]{1,256})@(?=[^\s/?#@])/g;
const percentDecoded = (value: string): string =>
  value.replace(/%([0-9A-Fa-f]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
// A URL password is judged by its percent-decoded value, so an encoded first
// character (%2F...) does not exempt it; a template or mask is recognized in
// either form (%DB_PASSWORD% only raw, %24%7BVAR%7D only decoded). A short
// password, the user name repeated (postgres:postgres), a whole-value
// template or mask, and a password made only of placeholder words are
// fixtures and examples.
const trivialPassword = (user: string, password: string): boolean => {
  const decoded = percentDecoded(password);
  return (
    decoded.length < 8 ||
    decoded.toLowerCase() === percentDecoded(user).toLowerCase() ||
    templateOrMask(password) ||
    templateOrMask(decoded) ||
    placeholderPassword.test(decoded)
  );
};
function urlCredentials(text: string): RegExpExecArray[] {
  return [...text.matchAll(urlCredential)].filter(
    (match) => !trivialPassword(match[2]!, match[3]!),
  );
}
const namedToken =
  /\b[A-Z][A-Z0-9_]*_TOKEN\s*[:=]\s*["']?(?!\$\{|process\.env|os\.environ|<|example|placeholder|your[-_]|test[-_]|undefined|null)[A-Za-z0-9+/_-]{16,}={0,2}/;
const bearerHeader =
  /\bauthorization\s*:\s*bearer\s+(?!<|example|placeholder|your[-_]|test[-_])[A-Za-z0-9._~+/-]{16,}={0,2}(?=\s|$|["'])/i;
export function containsSecret(text: string): boolean {
  return (
    knownKey.test(text) ||
    hasAssignedCredential(text) ||
    namedToken.test(text) ||
    bearerHeader.test(text) ||
    liveTokens(text).length > 0 ||
    urlCredentials(text).length > 0
  );
}
const privateKeyFooter = new RegExp(`-----END ${privateKeyLabel}-----`, "gi");
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
  for (const { start, end } of assignedCredentials(text))
    add("assigned", start, end);
  for (const match of liveTokens(text))
    add("live", match.index, match.index + match[0].length);
  for (const match of urlCredentials(text))
    add("url", match.index, match.index + match[0].length);
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
// Replaces the value of each assignment that screening detects.
function redactAssigned(text: string): string {
  let redacted = "";
  let from = 0;
  for (const { valueStart, end } of assignedCredentials(text)) {
    redacted += `${text.slice(from, valueStart)}[REDACTED]`;
    from = end;
  }
  return redacted + text.slice(from);
}
// Redaction is wider than detection for values named as a password, API
// key, secret or access token. Stored events, check output, run errors and
// review text are logs and messages, not source, and hold shapes screening
// leaves alone (PGPASSWORD=..., "connecting with password: ... to db", a
// value of 12 to 15 letters and digits, a value that looks like code), so
// any such value of 12 or more characters on the same line, up to an escaped
// newline, tab or quote, is redacted unless it is a whole-value template,
// mask, placeholder, interpolation or URL. Hiding a non-secret there costs
// little.
const namedValue =
  /((?:password|api[_-]?key|secret|access[_-]?token)[ \t]*[:=][ \t]*["'`]?)((?:[^\s"'`\\]|\\[^\snrt"'`]){12,})/gi;
// Redaction removes what containsSecret detects, and more (above). A private
// key header with no END marker (a truncated excerpt) is redacted through the
// end of the text: what follows may be key material, and an OpenPGP armor
// header can hold any character, so no shorter end is safe.
export function redact(text: string): string {
  return redactAssigned(text)
    .replace(
      namedValue,
      (
        match: string,
        prefix: string,
        value: string,
        offset: number,
        whole: string,
      ) => {
        // A name inside a shell expansion (${DB_PASSWORD:-fallback}) is
        // judged by its default value.
        const judged = /\$\{[\w-]*$/.test(
          whole.slice(Math.max(0, offset - 128), offset),
        )
          ? /^[-=?+]?([^}]*)/.exec(value)![1]!
          : value;
        return judged.length < 12 || inertValue(judged)
          ? match
          : `${prefix}[REDACTED]`;
      },
    )
    .replace(
      new RegExp(
        String.raw`-----BEGIN ${privateKeyLabel}-----(?:[\s\S]*?-----END ${privateKeyLabel}-----|[\s\S]*)`,
        "gi",
      ),
      "[REDACTED PRIVATE KEY]",
    )
    .replace(new RegExp(apiKey, "gi"), "[REDACTED]")
    .replace(liveToken, (token: string) =>
      placeholderToken(token) ? token : "[REDACTED]",
    )
    .replace(
      urlCredential,
      (match, prefix: string, user: string, password: string) =>
        trivialPassword(user, password) ? match : `${prefix}[REDACTED]@`,
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
    // A file name can hold a credential as well as its text, as the MCP
    // boundary also checks.
    items: packet.items.filter(
      (item) =>
        item.source &&
        isAllowedPath(item.source.path, policy, true) &&
        !containsSecret(item.source.path) &&
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
