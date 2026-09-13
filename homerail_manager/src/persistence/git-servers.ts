/**
 * - SQLite-backed GitServer persistence (CRUD + verify state).
 *
 * Source Issue: #948
 *
 * Provides CRUD for GitServer records stored in Manager SQLite. Tokens are
 * encrypted before being stored and returned masked through listServers /
 * getServer.
 */

import * as crypto from "node:crypto";
import { clearTables, encodeJson, getDb, parseJsonRow } from "./db.js";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  type EncryptedSecret,
} from "./secret-store.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GitServerRecord {
  server_id: string;
  name: string;
  platform_type: string; // 'github' | 'gitlab' | 'gitea'
  api_endpoint: string;
  token: string;
  git_user_name: string | null;
  git_user_email: string | null;
  is_active: boolean;
  token_valid: boolean;
  last_verified: string | null;
  user_info: {
    login: string;
    name: string;
    email: string;
    id: number;
    avatar_url: string;
    html_url: string;
  } | null;
  description: string;
  created_at: string;
  updated_at: string;
}

interface StoredGitServerRecord extends Omit<GitServerRecord, "token"> {
  token_encrypted?: EncryptedSecret;
  token?: string;
  secret_storage?: "manager_encrypted" | "legacy_plaintext";
}

/** Shape returned to callers -- never includes raw token. */
export type GitServerPublic = Omit<GitServerRecord, "token"> & {
  token_masked: string;
};

export interface CreateGitServerInput {
  name: string;
  platform_type: string;
  api_endpoint: string;
  token: string;
  git_user_name?: string;
  git_user_email?: string;
  description?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function _normalizeStoredRecord(raw: unknown): { record?: GitServerRecord; legacyPlaintext: boolean } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { legacyPlaintext: false };
  }
  const rec = raw as Record<string, unknown>;
  if (typeof rec.server_id !== "string") return { legacyPlaintext: false };
  if (typeof rec.name !== "string") return { legacyPlaintext: false };
  if (typeof rec.platform_type !== "string") return { legacyPlaintext: false };
  if (typeof rec.api_endpoint !== "string") return { legacyPlaintext: false };

  let token = "";
  let legacyPlaintext = false;
  if (isEncryptedSecret(rec.token_encrypted)) {
    token = decryptSecret(rec.token_encrypted);
  } else if (typeof rec.token === "string") {
    token = rec.token;
    legacyPlaintext = true;
  }

  const userInfo = typeof rec.user_info === "object" && rec.user_info !== null && !Array.isArray(rec.user_info)
    ? rec.user_info as GitServerRecord["user_info"]
    : null;

  return {
    legacyPlaintext,
    record: {
      server_id: rec.server_id,
      name: rec.name,
      platform_type: rec.platform_type,
      api_endpoint: rec.api_endpoint,
      token,
      git_user_name: typeof rec.git_user_name === "string" ? rec.git_user_name : null,
      git_user_email: typeof rec.git_user_email === "string" ? rec.git_user_email : null,
      is_active: typeof rec.is_active === "boolean" ? rec.is_active : true,
      token_valid: typeof rec.token_valid === "boolean" ? rec.token_valid : false,
      last_verified: typeof rec.last_verified === "string" ? rec.last_verified : null,
      user_info: userInfo,
      description: typeof rec.description === "string" ? rec.description : "",
      created_at: typeof rec.created_at === "string" ? rec.created_at : new Date().toISOString(),
      updated_at: typeof rec.updated_at === "string" ? rec.updated_at : new Date().toISOString(),
    },
  };
}

function _readAll(): GitServerRecord[] {
  const rows = getDb()
    .prepare("SELECT data FROM git_servers ORDER BY updated_at DESC, server_id")
    .all() as Array<{ data: string }>;
  let legacyPlaintext = false;
  const records = rows
    .map((row) => {
      try {
        const normalized = _normalizeStoredRecord(parseJsonRow<unknown>(row.data));
        legacyPlaintext = legacyPlaintext || normalized.legacyPlaintext;
        return normalized.record;
      } catch {
        return undefined;
      }
    })
    .filter((record): record is GitServerRecord => record !== undefined);
  if (legacyPlaintext) {
    _writeAll(records);
  }
  return records;
}

function _writeAll(records: GitServerRecord[]): void {
  const stored: StoredGitServerRecord[] = records.map(({ token, ...record }) => ({
    ...record,
    token_encrypted: encryptSecret(token),
    secret_storage: "manager_encrypted",
  }));
  const db = getDb();
  db.transaction(() => {
    db.prepare("DELETE FROM git_servers").run();
    const stmt = db.prepare("INSERT INTO git_servers(server_id, updated_at, data) VALUES (?, ?, ?)");
    for (const record of stored) {
      stmt.run(record.server_id, record.updated_at, encodeJson(record));
    }
  })();
}

function _generateId(): string {
  return crypto.randomBytes(12).toString("hex");
}

/** Mask a token using the first4****last4 pattern. */
export function maskToken(token: string): string {
  if (!token) return "";
  if (token.length <= 8) return "****";
  return `${token.slice(0, 4)}****${token.slice(-4)}`;
}

/** Strip raw token, add masked version. */
function _public(rec: GitServerRecord): GitServerPublic {
  const { token: _t, ...rest } = rec;
  return { ...rest, token_masked: maskToken(rec.token) };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listServers(activeOnly?: boolean): GitServerPublic[] {
  let records = _readAll();
  if (activeOnly) {
    records = records.filter((r) => r.is_active);
  }
  return records.map(_public);
}

export function getServer(id: string): GitServerPublic | undefined {
  const rec = _readAll().find((r) => r.server_id === id);
  return rec ? _public(rec) : undefined;
}

/** Returns the raw record (including token) for internal use by verify. */
export function getServerRaw(id: string): GitServerRecord | undefined {
  return _readAll().find((r) => r.server_id === id);
}

export function createServer(input: CreateGitServerInput): GitServerPublic {
  if (!input.name?.trim()) throw new Error("Missing required field: name");
  if (!input.platform_type?.trim()) throw new Error("Missing required field: platform_type");
  if (!input.api_endpoint?.trim()) throw new Error("Missing required field: api_endpoint");
  if (!input.token?.trim()) throw new Error("Missing required field: token");

  const supportedPlatforms = ["github", "gitlab", "gitea"];
  if (!supportedPlatforms.includes(input.platform_type.trim().toLowerCase())) {
    throw new Error(`Unsupported platform_type: ${input.platform_type}. Supported: ${supportedPlatforms.join(", ")}`);
  }

  const now = new Date().toISOString();
  const record: GitServerRecord = {
    server_id: _generateId(),
    name: input.name.trim(),
    platform_type: input.platform_type.trim().toLowerCase(),
    api_endpoint: input.api_endpoint.trim(),
    token: input.token.trim(),
    git_user_name: input.git_user_name?.trim() || null,
    git_user_email: input.git_user_email?.trim() || null,
    is_active: true,
    token_valid: false,
    last_verified: null,
    user_info: null,
    description: input.description?.trim() || "",
    created_at: now,
    updated_at: now,
  };

  const records = _readAll();
  records.push(record);
  _writeAll(records);
  return _public(record);
}

/** Update only public settings and the encrypted token. Empty optional strings
 * clear their field; a cleared token invalidates the verification state. */
export function updateServer(id: string, input: Record<string, unknown>): GitServerPublic | undefined {
  const records = _readAll();
  const rec = records.find(record => record.server_id === id);
  if (!rec) return undefined;
  const fields = new Set(["name", "token", "git_user_name", "git_user_email", "description", "is_active"]);
  for (const [key, value] of Object.entries(input)) {
    if (!fields.has(key)) throw new Error(`Unsupported Git server field: ${key}`);
    if (key === "is_active") {
      if (typeof value !== "boolean") throw new Error("is_active must be boolean");
      rec.is_active = value;
    } else {
      if (typeof value !== "string") throw new Error(`${key} must be a string`);
      if (key === "name" && !value.trim()) throw new Error("name must not be empty");
      if (key === "name") rec.name = value.trim();
      if (key === "description") rec.description = value.trim();
      if (key === "git_user_name") rec.git_user_name = value.trim() || null;
      if (key === "git_user_email") rec.git_user_email = value.trim() || null;
      if (key === "token") {
        rec.token = value.trim(); rec.token_valid = false; rec.last_verified = null; rec.user_info = null;
      }
    }
  }
  rec.updated_at = new Date().toISOString();
  _writeAll(records);
  return _public(rec);
}

export function deleteServer(id: string): boolean {
  const records = _readAll();
  const idx = records.findIndex((r) => r.server_id === id);
  if (idx === -1) return false;
  records.splice(idx, 1);
  _writeAll(records);
  return true;
}

export function updateVerifyState(
  id: string,
  token_valid: boolean,
  last_verified: string,
  user_info: GitServerRecord["user_info"],
): GitServerPublic | undefined {
  const records = _readAll();
  const idx = records.findIndex((r) => r.server_id === id);
  if (idx === -1) return undefined;
  records[idx] = {
    ...records[idx],
    token_valid,
    last_verified,
    user_info,
    updated_at: new Date().toISOString(),
  };
  _writeAll(records);
  return _public(records[idx]);
}

export function _clearAllServers(): void {
  clearTables(["git_servers"]);
}
