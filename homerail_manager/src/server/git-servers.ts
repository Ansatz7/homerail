/**
 * - HTTP route handler for /api/git-servers CRUD + verify.
 *
 * Source Issue: #948
 *
 * Routes:
 *   GET    /api/git-servers?active_only=false  -- list servers (masked tokens)
 *   POST   /api/git-servers                    -- create server
 *   DELETE /api/git-servers/{server_id}         -- delete server
 *   PUT    /api/git-servers/{server_id}         -- update settings or token
 *   POST   /api/git-servers/{server_id}/verify  -- verify token against platform
 *   GET    /api/git-servers/{server_id}/{user,repos,repository,branches}
 *   POST   /api/git-servers/verify-token        -- verify without saving
 *
 * Verify for gitea: real HTTP GET to ${api_endpoint}/api/v1/user
 * with Authorization: token ${stored_token}.
 */

import * as http from "node:http";
import {
  listServers,
  getServer,
  getServerRaw,
  createServer,
  updateServer,
  deleteServer,
  updateVerifyState,
  type CreateGitServerInput,
} from "../persistence/git-servers.js";

import { giteaApiRoot, giteaRequest, gitUser, gitRepository, gitPagination, GitServerUpstreamError } from "./gitea-client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BaseResponse {
  success: boolean;
  message: string;
  data?: unknown;
  error?: string;
}

function json(res: http.ServerResponse, status: number, body: BaseResponse) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function _badRequest(res: http.ServerResponse, message: string) {
  json(res, 400, { success: false, message, error: message });
}

function _notFound(res: http.ServerResponse, message: string) {
  json(res, 404, { success: false, message, error: message });
}

function _ok(res: http.ServerResponse, message: string, data?: unknown) {
  json(res, 200, { success: true, message, data });
}

function _created(res: http.ServerResponse, message: string, data: unknown) {
  json(res, 201, { success: true, message, data });
}

function _verifyFailed(res: http.ServerResponse, status: number, message: string, data: unknown) {
  json(res, status, { success: false, message, data, error: message });
}

async function _readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function _requiredString(
  body: Record<string, unknown>,
  field: string,
): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// ---------------------------------------------------------------------------
// Verify implementation
// ---------------------------------------------------------------------------

interface VerifyResult {
  valid: boolean;
  user_info?: {
    login: string;
    name: string;
    email: string;
    id: number;
    avatar_url: string;
    html_url: string;
  };
}

async function _verifyGitea(apiEndpoint: string, token: string): Promise<VerifyResult> {
  return { valid: true, user_info: gitUser(await giteaRequest({ platform_type: "gitea", api_endpoint: apiEndpoint, token }, "/user")) };
}

function upstreamFailure(res: http.ServerResponse, error: unknown): void {
  const status = error instanceof GitServerUpstreamError ? error.status : 400;
  const message = error instanceof GitServerUpstreamError ? error.message : "Invalid Git server request";
  json(res, status, { success: false, message, error: message });
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export function gitServersRoutesHandler(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): boolean {
  const urlObj = new URL(req.url || "/", "http://localhost");
  const pathname = urlObj.pathname;

  // Only handle /api/git-servers paths
  if (!pathname.startsWith("/api/git-servers")) return false;

  // GET /api/git-servers -- list
  if (pathname === "/api/git-servers" && req.method === "GET") {
    const activeOnly = urlObj.searchParams.get("active_only") !== "false";
    const servers = listServers(activeOnly);
    _ok(res, `Found ${servers.length} git servers`, { servers });
    return true;
  }

  // POST /api/git-servers -- create
  if (pathname === "/api/git-servers" && req.method === "POST") {
    _readJsonBody(req)
      .then((raw) => {
        const body = raw as Record<string, unknown>;
        const name = _requiredString(body, "name");
        const platform_type = _requiredString(body, "platform_type");
        const api_endpoint = _requiredString(body, "api_endpoint");
        const token = _requiredString(body, "token");

        if (!name) {
          _badRequest(res, "Missing required field: name");
          return;
        }
        if (!platform_type) {
          _badRequest(res, "Missing required field: platform_type");
          return;
        }
        if (!api_endpoint) {
          _badRequest(res, "Missing required field: api_endpoint");
          return;
        }
        if (!token) {
          _badRequest(res, "Missing required field: token");
          return;
        }

        giteaApiRoot(api_endpoint);
        const input: CreateGitServerInput = {
          name,
          platform_type,
          api_endpoint,
          token,
          git_user_name:
            typeof body.git_user_name === "string"
              ? body.git_user_name
              : undefined,
          git_user_email:
            typeof body.git_user_email === "string"
              ? body.git_user_email
              : undefined,
          description:
            typeof body.description === "string"
              ? body.description
              : undefined,
        };

        try {
          const server = createServer(input);
          _created(res, "Git server created", server);
        } catch (err) {
          _badRequest(
            res,
            err instanceof Error ? err.message : String(err),
          );
        }
      })
      .catch(() => _badRequest(res, "Invalid Git server request body"));
    return true;
  }

  if (pathname === "/api/git-servers/verify-token" && req.method === "POST") {
    void _readJsonBody(req).then(async raw => {
      const body = raw as Record<string, unknown>;
      const platform = urlObj.searchParams.get("platform_type") ?? _requiredString(body, "platform_type");
      const endpoint = urlObj.searchParams.get("api_endpoint") ?? _requiredString(body, "api_endpoint");
      const token = _requiredString(body, "token");
      if (!platform || !endpoint || !token) throw new Error("Missing verification fields");
      const user = gitUser(await giteaRequest({ platform_type: platform, api_endpoint: endpoint, token }, "/user"));
      _ok(res, "Token verified", { valid: true, platform, user });
    }).catch(error => upstreamFailure(res, error));
    return true;
  }

  const queryMatch = pathname.match(/^\/api\/git-servers\/([^/]+)\/(user|repos|repository|branches)$/);
  if (queryMatch && req.method === "GET") {
    const serverId = decodeURIComponent(queryMatch[1]);
    const raw = getServerRaw(serverId);
    if (!raw) { _notFound(res, "Git server not found"); return true; }
    void (async () => {
      if (!raw.is_active) throw new GitServerUpstreamError(409, "Git server is inactive");
      const action = queryMatch[2];
      if (action === "user") {
        _ok(res, "Git user retrieved", { user: gitUser(await giteaRequest(raw, "/user")) }); return;
      }
      const pagination = gitPagination(urlObj.searchParams);
      const query = `?page=${pagination.page}&limit=${pagination.per_page}`;
      if (action === "repos") {
        const repos = await giteaRequest(raw, "/user/repos" + query);
        if (!Array.isArray(repos)) throw new GitServerUpstreamError(502, "Invalid Git server repository response");
        _ok(res, "Repositories retrieved", { repositories: repos.map(gitRepository), ...pagination }); return;
      }
      const owner = urlObj.searchParams.get("owner"), repo = urlObj.searchParams.get("repo_name");
      if (!owner || !repo || [owner, repo].some(part => part === "." || part === ".." || /[\/\\]/.test(part))) throw new Error("Invalid owner or repo_name");
      const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
      const repository = gitRepository(await giteaRequest(raw, repoPath));
      if (action === "repository") { _ok(res, "Repository retrieved", { repository }); return; }
      const branches = await giteaRequest(raw, repoPath + "/branches" + query);
      if (!Array.isArray(branches)) throw new GitServerUpstreamError(502, "Invalid Git server branch response");
      _ok(res, "Branches retrieved", { branches: branches.map((branch: any) => ({ name: String(branch.name ?? ""), sha: String(branch.commit?.id ?? ""), is_default: branch.name === repository.default_branch })), ...pagination });
    })().catch(error => {
      if (error instanceof GitServerUpstreamError && [401, 403].includes(error.status)) updateVerifyState(serverId, false, new Date().toISOString(), null);
      upstreamFailure(res, error);
    });
    return true;
  }
  if (queryMatch && req.method === "PUT") {
    json(res, 409, { success: false, message: "Repository binding belongs to a project; update /api/projects/:id using git_server_id and git_repository", error: "GIT_REPOSITORY_BINDING_PROJECT_REQUIRED" });
    return true;
  }

  // Extract server_id from path
  const serverIdMatch = pathname.match(
    /^\/api\/git-servers\/([^/]+)(?:\/(verify))?$/,
  );
  if (!serverIdMatch) return false;

  const serverId = decodeURIComponent(serverIdMatch[1]);
  const subAction = serverIdMatch[2];

  // POST /api/git-servers/{server_id}/verify
  if (subAction === "verify" && req.method === "POST") {
    const raw = getServerRaw(serverId);
    if (!raw) {
      _notFound(res, `Git server not found: ${serverId}`);
      return true;
    }

    if (raw.platform_type === "gitea") {
      _verifyGitea(raw.api_endpoint, raw.token)
        .then((result) => {
          const now = new Date().toISOString();
          updateVerifyState(serverId, result.valid, now, result.user_info ?? null);
          const data = {
            server_id: serverId,
            valid: result.valid,
            token_valid: result.valid,
            last_verified: now,
            user_info: result.user_info ?? null,
          };
          if (result.valid) {
            _ok(res, "Token verified", data);
          } else {
            _verifyFailed(res, 401, "Token invalid", data);
          }
        })
        .catch((err) => {
          const now = new Date().toISOString();
          updateVerifyState(serverId, false, now, null);
          _verifyFailed(res, err instanceof GitServerUpstreamError ? err.status : 502, "Verification failed", {
            server_id: serverId,
            valid: false,
            token_valid: false,
            last_verified: now,
            user_info: null,
            error: "Git server verification failed",
          });
        });
    } else {
      _badRequest(
        res,
        `Verify not supported for platform_type: ${raw.platform_type}. Only gitea is supported.`,
      );
    }
    return true;
  }

  if (!subAction && req.method === "PUT") {
    void _readJsonBody(req).then(raw => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Expected object");
      const server = updateServer(serverId, raw as Record<string, unknown>);
      if (!server) _notFound(res, "Git server not found"); else _ok(res, "Git server updated", server);
    }).catch(error => upstreamFailure(res, error));
    return true;
  }

  // DELETE /api/git-servers/{server_id}
  if (!subAction && req.method === "DELETE") {
    const removed = deleteServer(serverId);
    if (!removed) {
      _notFound(res, `Git server not found: ${serverId}`);
      return true;
    }
    _ok(res, "Git server deleted", { server_id: serverId });
    return true;
  }

  // GET /api/git-servers/{server_id}
  if (!subAction && req.method === "GET") {
    const server = getServer(serverId);
    if (!server) {
      _notFound(res, `Git server not found: ${serverId}`);
      return true;
    }
    _ok(res, "Git server retrieved", server);
    return true;
  }

  return false;
}
