import { resolveHomerailHome } from "../platform/paths.js";
import { homerailWorkerWorkspacePath } from "./homerail-home.js";
import { lstatSync, mkdirSync, readdirSync, realpathSync, type Stats } from "node:fs";
import path from "node:path";
import { normalizeWorkspaceAccess, normalizeWorkspacePolicyPath, workspacePathWithin, WORKSPACE_PROTECTED_NAMES, type DagWorkspaceAccess } from "homerail-protocol";

const DENIED_PATHS = ["/etc", "/proc", "/sys", "/dev"];

export interface MountPolicyOptions {
  allowDockerSocket?: boolean;
  allowedHostRoots?: string[];
}

export interface MountEntry {
  host: string;
  container: string;
  mode?: string;
}

export class MountPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MountPolicyError";
  }
}

export function validateMounts(
  mounts: MountEntry[],
  options: MountPolicyOptions = {},
): void {
  const homerailHome = resolveHomerailHome();
  const allowedHostRoots = (options.allowedHostRoots ?? [])
    .map((root) => root.replace(/\\/g, "/").replace(/\/+$/, ""))
    .filter((root) => root && root !== "/" && !DENIED_PATHS.some((denied) => root === denied || root.startsWith(`${denied}/`)));

  for (const mount of mounts) {
    const host = mount.host.replace(/\\/g, "/");

    if (DENIED_PATHS.includes(host)) {
      throw new MountPolicyError(
        `Mount denied: "${host}" is a protected system directory`,
      );
    }

    if (host === "/var/run/docker.sock") {
      if (options.allowDockerSocket) {
        continue;
      }
      throw new MountPolicyError(
        `Mount denied: Docker socket mount requires allowDockerSocket: true`,
      );
    }

    const insideHomerailHome = host === homerailHome || host.startsWith(homerailHome + "/");
    const insideAllowedRoot = allowedHostRoots.some((root) => host === root || host.startsWith(root + "/"));
    if (!insideHomerailHome && !insideAllowedRoot) {
      throw new MountPolicyError(
        `Mount denied: "${mount.host}" is outside .homerail tree (${homerailHome})`,
      );
    }
  }
}

export function allowedMounts(volumeId: string): MountEntry[] {
  const homerailHome = resolveHomerailHome();
  return [
    {
      host: `${homerailHome}/node/volumes/${volumeId}`,
      container: "/workspace",
      mode: "rw",
    },
    {
      host: `${homerailHome}/home`,
      container: "/home/node",
      mode: "rw",
    },
  ];
}

function safeWorkerWritableSubpath(value: string): string {
  const normalized = normalizeWorkspacePolicyPath(value);
  normalizeWorkspaceAccess({ writable_paths: [normalized] });
  return normalized;
}

export function workerAllowedMounts(
  workspaceId: string,
  readOnly = false,
  readOnlyInputs = false,
  writableSubpath?: string,
  gitMetadataReadOnly = false,
  workspaceAccess?: DagWorkspaceAccess,
): MountEntry[] {
  if (workspaceAccess !== undefined) {
    if (!readOnly) throw new Error("workspace_access requires a read-only workspace root");
    const access = normalizeWorkspaceAccess(workspaceAccess);
    if (writableSubpath !== undefined && (access.writable_paths.length !== 1 || safeWorkerWritableSubpath(writableSubpath) !== access.writable_paths[0])) {
      throw new Error("legacy writableSubpath conflicts with workspace_access");
    }
    return scopedWorkerMounts(workspaceId, access);
  }
  if (writableSubpath !== undefined && !readOnly) {
    throw new Error("writableSubpath requires a read-only workspace root");
  }
  if (gitMetadataReadOnly && writableSubpath === undefined) {
    throw new Error("read-only Git metadata requires writableSubpath");
  }
  const normalizedWritableSubpath = writableSubpath === undefined
    ? undefined
    : safeWorkerWritableSubpath(writableSubpath);
  if (
    normalizedWritableSubpath === "input"
    || normalizedWritableSubpath?.startsWith("input/")
    || normalizedWritableSubpath === ".homerail-runtime"
    || normalizedWritableSubpath?.startsWith(".homerail-runtime/")
  ) {
    throw new Error("writableSubpath conflicts with a protected workspace mount");
  }
  const mounts: MountEntry[] = [
    {
      host: homerailWorkerWorkspacePath(workspaceId),
      container: "/workspace",
      mode: readOnly ? "ro" : "rw",
    },
  ];
  if (readOnly) {
    mounts.push({
      host: `${homerailWorkerWorkspacePath(workspaceId)}/.homerail-runtime`,
      container: "/workspace/.homerail-runtime",
      mode: "rw",
    });
  }
  if (readOnlyInputs) {
    mounts.push({
      host: `${homerailWorkerWorkspacePath(workspaceId)}/input`,
      container: "/workspace/input",
      mode: "ro",
    });
  }
  if (normalizedWritableSubpath) {
    mounts.push({
      host: homerailWorkerWorkspacePath(`${workspaceId}/${normalizedWritableSubpath}`),
      container: `/workspace/${normalizedWritableSubpath}`,
      mode: "rw",
    });
    if (gitMetadataReadOnly) {
      mounts.push({
        host: `${homerailWorkerWorkspacePath(`${workspaceId}/${normalizedWritableSubpath}`)}/.git`,
        container: `/workspace/${normalizedWritableSubpath}/.git`,
        mode: "ro",
      });
    }
  }
  return mounts;
}

/** Reject symlinks in every bind source component, including workspace ancestors.
 * Missing targets are deliberately not guessed to be files or directories. */
function checkedMountSource(absolute: string): Stats {
  let cursor = path.parse(path.resolve(absolute)).root;
  for (const segment of path.resolve(absolute).slice(cursor.length).split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) throw new Error(`workspace mount source must not traverse a symlink: ${cursor}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`workspace mount source must be a regular file or directory: ${cursor}`);
  }
  return lstatSync(absolute);
}

/** Run before preparation/materialization can create anything on the host. */
export function assertWorkspacePreparationBoundary(workspaceId: string): void {
  const root = homerailWorkerWorkspacePath(workspaceId);
  for (const absolute of [root, path.join(root, "input"), path.join(root, ".homerail-runtime")]) {
    let cursor = path.parse(path.resolve(absolute)).root;
    for (const segment of path.resolve(absolute).slice(cursor.length).split(path.sep)) {
      cursor = path.join(cursor, segment);
      try {
        if (lstatSync(cursor).isSymbolicLink()) throw new Error(`workspace preparation cannot traverse a symlink: ${cursor}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") break;
        throw error;
      }
    }
  }
}

function scopedWorkerMounts(workspaceId: string, access: DagWorkspaceAccess): MountEntry[] {
  const root = homerailWorkerWorkspacePath(workspaceId);
  if (!checkedMountSource(root).isDirectory()) throw new Error("workspace root must be a directory");
  const mounts: MountEntry[] = [{ host: root, container: "/workspace", mode: "ro" }];
  const protections = new Set<string>();
  let scanned = 0;
  // A read-only alias must not point into a write grant: writing its target
  // would otherwise change AGENTS/receipts/source through a read-only mount.
  const checkAliases = (absolute: string, relative: string): void => {
    if (++scanned > 100_000) throw new Error("workspace mount protection scan exceeds 100000 entries");
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) {
      const target = realpathSync(absolute);
      const targetRelative = path.relative(root, target).split(path.sep).join("/");
      if (targetRelative.startsWith("../") || targetRelative === ".." || path.isAbsolute(targetRelative)
        || relative.split("/").some(s => WORKSPACE_PROTECTED_NAMES.has(s))
        || access.writable_paths.some(writable => workspacePathWithin(targetRelative, writable) || workspacePathWithin(writable, targetRelative || "."))) {
        throw new Error(`workspace symlink escapes root or aliases a protected/write boundary: ${relative}`);
      }
    } else if (stat.isDirectory()) {
      if (relative === ".homerail-runtime") return;
      for (const name of readdirSync(absolute)) checkAliases(path.join(absolute, name), relative ? `${relative}/${name}` : name);
    } else if (!stat.isFile()) throw new Error(`unsupported workspace entry: ${relative}`);
  };
  checkAliases(root, "");
  scanned = 0;
  const scan = (relative: string): void => {
    if (++scanned > 100_000) throw new Error("workspace mount protection scan exceeds 100000 entries");
    const absolute = path.join(root, relative);
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`writable workspace subtree contains a symlink: ${relative}`);
    if (!stat.isDirectory() && !stat.isFile()) throw new Error(`unsupported workspace entry: ${relative}`);
    if (WORKSPACE_PROTECTED_NAMES.has(path.basename(relative)) || (access.readonly_paths ?? []).includes(relative)) {
      protections.add(relative);
      return;
    }
    if (stat.isFile() && stat.nlink > 1) throw new Error(`writable workspace file has hard links: ${relative}`);
    if (stat.isDirectory()) for (const name of readdirSync(absolute)) scan(`${relative}/${name}`);
  };
  for (const writable of access.writable_paths) {
    const absolute = path.join(root, writable);
    try { checkedMountSource(absolute); } catch (error) {
      throw new Error(`writable target must already exist without symlinks (pre-create new files explicitly): ${writable}: ${String(error)}`);
    }
    scan(writable);
    mounts.push({ host: absolute, container: `/workspace/${writable}`, mode: "rw" });
  }
  for (const readonly of access.readonly_paths ?? []) {
    if (access.writable_paths.some(writable => workspacePathWithin(readonly, writable))) {
      checkedMountSource(path.join(root, readonly));
      protections.add(readonly);
    }
  }
  // Nested read-only protections win over writable directory grants. Only bind
  // the outermost protection; descendants are already covered recursively.
  const outerProtections = [...protections].filter(readonly => ![...protections].some(other => other !== readonly && workspacePathWithin(readonly, other)));
  const anchors = new Set<string>();
  for (const readonly of outerProtections) {
    const writable = access.writable_paths.find(root => workspacePathWithin(readonly, root))!;
    let parent = path.posix.dirname(readonly);
    while (parent !== writable && workspacePathWithin(parent, writable)) {
      anchors.add(parent);
      parent = path.posix.dirname(parent);
    }
  }
  if (outerProtections.length + anchors.size + mounts.length + 2 > 256) throw new Error("workspace policy exceeds 256 bind mounts; narrow writable directories");
  // Anchor each intermediate directory as a mount point. Otherwise an actor
  // could rename a parent containing a read-only child, then replace that path.
  // These rw mounts are wholly inside an existing write grant; they add no scope.
  for (const anchor of [...anchors].sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    mounts.push({ host: path.join(root, anchor), container: `/workspace/${anchor}`, mode: "rw" });
  }
  for (const readonly of outerProtections.sort()) {
    mounts.push({ host: path.join(root, readonly), container: `/workspace/${readonly}`, mode: "ro" });
  }
  // Trusted runtime telemetry has its own mount; model-owned receipts remain
  // on the read-only root. Never follow an existing runtime/input symlink.
  for (const [name, mode] of [["input", "ro"], [".homerail-runtime", "rw"]] as const) {
    const absolute = path.join(root, name);
    try { checkedMountSource(absolute); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(absolute, { mode: 0o700 });
      checkedMountSource(absolute);
    }
    if (!lstatSync(absolute).isDirectory()) throw new Error(`protected workspace mount must be a directory: ${name}`);
    mounts.push({ host: absolute, container: `/workspace/${name}`, mode });
  }
  return mounts;
}
