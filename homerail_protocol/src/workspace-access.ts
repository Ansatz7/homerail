/** @version 0.1.0 — scoped workspace mount contract shared across runtimes. */
import type { DagWorkspaceAccess } from "./types.js";

/** Shared by validation, provisioning and the Worker. No filesystem assumptions. */
export const WORKSPACE_PROTECTED_NAMES = new Set([
  ".git", ".homerail-runtime", "node_modules", "AGENTS.md", "receipts",
]);

export function normalizeWorkspacePolicyPath(value: string): string {
  if (typeof value !== "string") throw new Error("workspace policy path must be a string");
  const normalized = value.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("workspace policy path must be a non-empty relative workspace path");
  }
  if (normalized !== "." && normalized.split("/").some(s => !s || s === "." || s === ".." || !/^[A-Za-z0-9._-]+$/.test(s))) {
    throw new Error("workspace policy path contains an unsafe path segment or unsupported characters");
  }
  return normalized;
}

export function workspacePathWithin(candidate: string, parent: string): boolean {
  return parent === "." || candidate === parent || candidate.startsWith(`${parent}/`);
}

export function protectedWorkspacePath(candidate: string): boolean {
  return workspacePathWithin(candidate, "input")
    || candidate.split("/").some(s => WORKSPACE_PROTECTED_NAMES.has(s));
}

export function normalizeWorkspaceAccess(value: unknown): DagWorkspaceAccess {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("workspace_access must be an object");
  const access = value as DagWorkspaceAccess;
  if (!Array.isArray(access.writable_paths) || access.writable_paths.length > 32
    || (access.readonly_paths !== undefined && (!Array.isArray(access.readonly_paths) || access.readonly_paths.length > 128))) {
    throw new Error("workspace_access requires at most 32 writable_paths and 128 readonly_paths");
  }
  const writable = access.writable_paths.map(normalizeWorkspacePolicyPath);
  const readonly = [...new Set((access.readonly_paths ?? []).map(normalizeWorkspacePolicyPath))];
  for (const root of readonly) {
    const reserved = root.split("/").find(s => [".git", ".homerail-runtime", "node_modules"].includes(s));
    if (reserved) throw new Error(`workspace policy path contains reserved segment ${reserved}; protected metadata is mounted automatically`);
  }
  if (access.git_metadata_read_only === true && writable.length === 0) {
    throw new Error("read-only Git metadata requires non-root writable workspace paths");
  }
  for (const [index, root] of writable.entries()) {
    if (root === ".") throw new Error("workspace root must remain read-only; declare non-root writable paths");
    if (protectedWorkspacePath(root)) {
      const reserved = root.split("/").find(s => WORKSPACE_PROTECTED_NAMES.has(s)) ?? "input";
      throw new Error(`workspace writable path contains reserved segment ${reserved}; conflicts with protected workspace mount: ${root}`);
    }
    if (writable.some((other, i) => i !== index && (workspacePathWithin(root, other) || workspacePathWithin(other, root)))) {
      throw new Error("workspace writable paths must not overlap or repeat");
    }
    // A narrower read-only path is an explicit protection inside a writable
    // directory. A broader read-only grant cannot be undone by a write grant.
    if (readonly.some(other => workspacePathWithin(root, other))) {
      throw new Error(`workspace writable path overlaps a read-only ancestor: ${root}`);
    }
  }
  return { ...access, writable_paths: writable, readonly_paths: readonly };
}

export function workspacePathIsWritable(candidate: string, access: DagWorkspaceAccess): boolean {
  return !protectedWorkspacePath(candidate)
    && access.writable_paths.some(root => workspacePathWithin(candidate, root))
    && !(access.readonly_paths ?? []).some(root => workspacePathWithin(candidate, root));
}
