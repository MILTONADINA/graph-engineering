import path from "node:path";

const BAKED = "/opt/graph-deps";
const WORKSPACE = "/workspace";
export function createSetupController(input) {
  const tree = new Map(
    input.tree.map((item) => [item.path, structuredClone(item)]),
  );
  const commands = [],
    wrapperErrors = [];
  let stdout = "",
    stderr = "",
    exitCode = 0,
    ended = false,
    violated = false,
    calls = 0,
    lastError = null,
    uncaught = null;
  const refuse = () => {
    violated = true;
    throw new Error("Unsupported setup fixture capability");
  };
  function failure(code, message) {
    lastError = { code, message };
    throw Object.assign(new Error(message), { code });
  }
  function location(name, write = false) {
    if (
      typeof name !== "string" ||
      name.length > 2048 ||
      name.includes("\0") ||
      name.includes("\\") ||
      !name.startsWith("/")
    )
      return refuse();
    const normalized = path.posix.normalize(name);
    if (
      normalized !== WORKSPACE &&
      !normalized.startsWith(WORKSPACE + "/") &&
      (write || (normalized !== BAKED && !normalized.startsWith(BAKED + "/")))
    )
      return refuse();
    if (
      write &&
      normalized !== WORKSPACE &&
      normalized !== WORKSPACE + "/node_modules" &&
      !normalized.startsWith(WORKSPACE + "/node_modules/")
    )
      return refuse();
    return normalized;
  }
  function parentSafe(name) {
    for (
      let parent = path.posix.dirname(name);
      parent !== "/";
      parent = path.posix.dirname(parent)
    ) {
      const entry = tree.get(parent);
      if (entry?.type === "symlink")
        failure(
          "ELOOP",
          "Existing dependency path redirects through a symlink",
        );
    }
  }
  function info(name) {
    name = location(name);
    const value = tree.get(name);
    if (!value) failure("ENOENT", "Missing fixture filesystem entry");
    return value;
  }
  function mkdir(name, options) {
    name = location(name, true);
    parentSafe(name);
    const existing = tree.get(name);
    if (existing && existing.type !== "directory")
      failure("ENOTDIR", "Dependency destination is not a directory");
    if (!existing) {
      if (!(tree.get(path.posix.dirname(name))?.mode & 0o200))
        failure("EACCES", "Dependency parent directory is not owner-writable");
      tree.set(name, {
        path: name,
        type: "directory",
        mode: options?.mode ?? 0o755,
      });
    }
  }
  function copyFile(source, destination) {
    source = location(source);
    destination = location(destination, true);
    parentSafe(destination);
    const entry = info(source);
    if (!(tree.get(path.posix.dirname(destination))?.mode & 0o200))
      failure("EACCES", "Dependency parent directory is not owner-writable");
    if (input.copyFault)
      failure("EACCES", "Fixture file copy permission denied");
    if (entry.type !== "file")
      failure("EINVAL", "Source is not a regular file");
    const existing = tree.get(destination);
    if (existing && existing.type !== "file")
      failure("ELOOP", "File copy destination is not regular");
    tree.set(destination, { ...entry, path: destination });
  }
  function copyTree(source, destination) {
    source = location(source);
    destination = location(destination, true);
    parentSafe(destination);
    if (input.cpFault)
      failure("EACCES", "Fixture native recursive cp bind-mount failure");
    const entry = info(source);
    if (tree.get(destination)?.type === "symlink")
      failure("ELOOP", "Copy destination is an existing symlink");
    if (entry.type === "file") copyFile(source, destination);
    else if (entry.type === "symlink")
      tree.set(destination, { ...entry, path: destination });
    else {
      mkdir(destination, { mode: entry.mode | 0o700 });
      for (const child of [...tree.keys()].filter(
        (name) => path.posix.dirname(name) === source,
      ))
        copyTree(
          child,
          path.posix.join(destination, path.posix.basename(child)),
        );
      tree.get(destination).mode = entry.mode;
    }
  }
  function dispatch(operation, args) {
    if (++calls > 256 || ended) return refuse();
    if (operation === "cwd" && args.length === 0) return WORKSPACE;
    if (operation === "existsSync" && args.length === 1)
      return tree.has(location(args[0]));
    if (operation === "lstatSync" && args.length === 1) {
      const value = info(args[0]);
      return { type: value.type, mode: value.mode };
    }
    if (operation === "readFileSync" && args.length === 1) {
      const value = info(args[0]);
      if (value.type !== "file") failure("EISDIR", "Not a fixture file");
      return value.content;
    }
    if (operation === "readdirSync" && args.length === 1) {
      const name = location(args[0]);
      if (info(name).type !== "directory")
        failure("ENOTDIR", "Not a fixture directory");
      return [...tree.keys()]
        .filter((child) => path.posix.dirname(child) === name)
        .map((child) => path.posix.basename(child))
        .sort();
    }
    if (operation === "readlinkSync" && args.length === 1) {
      const value = info(args[0]);
      if (value.type !== "symlink") failure("EINVAL", "Not a fixture symlink");
      return value.target;
    }
    if (
      operation === "mkdirSync" &&
      args.length === 2 &&
      args[1]?.recursive === true &&
      Number.isInteger(args[1]?.mode) &&
      args[1].mode >= 0 &&
      args[1].mode <= 0o777
    ) {
      mkdir(...args);
      return null;
    }
    if (
      operation === "chmodSync" &&
      args.length === 2 &&
      Number.isInteger(args[1]) &&
      args[1] >= 0 &&
      args[1] <= 0o777
    ) {
      const name = location(args[0], true);
      parentSafe(name);
      info(name).mode = args[1];
      return null;
    }
    if (operation === "copyFileSync" && args.length === 2) {
      copyFile(...args);
      return null;
    }
    if (
      operation === "cpSync" &&
      args.length === 3 &&
      args[2]?.recursive === true &&
      args[2]?.dereference === false &&
      args[2]?.verbatimSymlinks === true
    ) {
      copyTree(args[0], args[1]);
      return null;
    }
    if (
      operation === "symlinkSync" &&
      args.length === 2 &&
      typeof args[0] === "string" &&
      args[0].length < 1000 &&
      !args[0].startsWith("/")
    ) {
      const destination = location(args[1], true);
      parentSafe(destination);
      if (!(tree.get(path.posix.dirname(destination))?.mode & 0o200))
        failure("EACCES", "Dependency parent directory is not owner-writable");
      const target = path.posix.resolve(
        path.posix.dirname(destination),
        args[0],
      );
      if (!target.startsWith(WORKSPACE + "/node_modules/")) return refuse();
      if (tree.has(destination))
        failure("EEXIST", "Dependency symlink destination exists");
      tree.set(destination, {
        path: destination,
        type: "symlink",
        mode: 0o777,
        target: args[0],
      });
      return null;
    }
    if (operation === "spawnSync" && args.length === 3) {
      const [executable, argv, options] = args;
      const fixed = [
        ["run", "check"],
        ["test", "--prefix", "graph-templates/tools/validate-graph"],
      ][commands.length];
      if (
        executable !== "npm" ||
        JSON.stringify(argv) !== JSON.stringify(fixed) ||
        options?.shell !== false ||
        options?.stdio !== "inherit" ||
        (options.cwd !== undefined && options.cwd !== WORKSPACE)
      )
        return refuse();
      commands.push({
        executable,
        args: [...argv],
        cwd: WORKSPACE,
        shell: false,
        stdio: "inherit",
      });
      const child = input.children[commands.length - 1];
      stdout += child.stdout;
      stderr += child.stderr;
      if (child.error) lastError = { ...child.error };
      return child;
    }
    if (
      ["stdout", "stderr"].includes(operation) &&
      args.length === 1 &&
      typeof args[0] === "string" &&
      args[0].length <= 2000
    ) {
      if (operation === "stdout") stdout += args[0] + "\n";
      else {
        wrapperErrors.push(args[0]);
        stderr += args[0] + "\n";
      }
      return null;
    }
    if (
      ["exit", "exitCode"].includes(operation) &&
      args.length === 1 &&
      Number.isInteger(args[0]) &&
      args[0] >= 0 &&
      args[0] <= 255
    ) {
      exitCode = args[0];
      ended = operation === "exit";
      return null;
    }
    return refuse();
  }
  function capability(text) {
    try {
      if (typeof text !== "string" || Buffer.byteLength(text) > 16000)
        return refuse();
      const value = JSON.parse(text);
      let nodes = 0;
      const validate = (item, depth = 0) => {
        if (++nodes > 2000 || depth > 20) return refuse();
        if (item && typeof item === "object")
          for (const [key, child] of Object.entries(item)) {
            if (["__proto__", "prototype", "constructor"].includes(key))
              return refuse();
            validate(child, depth + 1);
          }
      };
      validate(value);
      if (
        !value ||
        Object.keys(value).sort().join(",") !== "args,operation" ||
        typeof value.operation !== "string" ||
        !Array.isArray(value.args) ||
        value.args.length > 4
      )
        return refuse();
      return JSON.stringify({
        ok: true,
        value: dispatch(value.operation, value.args),
      });
    } catch (error) {
      return JSON.stringify({
        ok: false,
        error: { message: error.message, code: error.code ?? null },
      });
    }
  }
  return {
    capability,
    get violated() {
      return violated;
    },
    get ended() {
      return ended;
    },
    normalizeUncaught(error) {
      // Match ordinary metadata exceptions against independently mismatching
      // fixture files. VM faults and unrelated candidate exceptions remain errors.
      const metadataFailure =
        error?.code === null &&
        input.tree.some((entry) => {
          if (entry.type !== "file" || !entry.path.startsWith(BAKED + "/"))
            return false;
          const relative = entry.path.slice(BAKED.length + 1);
          if (
            !["package.json", "package-lock.json"].includes(
              path.posix.basename(relative),
            )
          )
            return false;
          const destination = tree.get(WORKSPACE + "/" + relative);
          const described = relative.includes("/") ? relative : "/" + relative;
          return (
            destination?.content !== entry.content &&
            error.message ===
              "Dependency metadata changed: " +
                described +
                ". Rebuild the verification image explicitly."
          );
        });
      if (
        violated ||
        (!metadataFailure &&
          (!lastError ||
            error?.message !== lastError.message ||
            error?.code !== lastError.code))
      )
        return false;
      exitCode = 1;
      uncaught = { ...error };
      stderr +=
        "Uncaught " + (error.code ?? "Error") + ": " + error.message + "\n";
      return true;
    },
    inspect() {
      if (violated) throw new Error("Refused setup capability");
      const destination = [...tree.values()]
        .filter(
          (item) =>
            item.path === WORKSPACE + "/node_modules" ||
            item.path.startsWith(WORKSPACE + "/node_modules/"),
        )
        .map((item) => ({
          path: item.path.slice(WORKSPACE.length + 1),
          type: item.type,
          mode: item.mode,
          ...(item.content !== undefined ? { content: item.content } : {}),
          ...(item.target !== undefined ? { target: item.target } : {}),
        }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return {
        exitCode,
        stdout,
        stderr,
        wrapperErrors,
        commands,
        destination,
        outside: tree.get("/outside/canary").content,
        uncaught,
      };
    },
  };
}
