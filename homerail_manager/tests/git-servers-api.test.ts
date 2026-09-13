import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server/http.js";
import { closeDb, getDb } from "../src/persistence/db.js";

async function listen(server: http.Server) { await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; }
describe("Git server UI API contract", () => {
  let home: string, previous: string | undefined, manager: http.Server, upstream: http.Server, base: string, endpoint: string;
  let status = 200; const token = "synthetic-gitea-private-token";
  let requests: string[];
  beforeEach(async () => {
    previous = process.env.HOMERAIL_HOME; home = fs.mkdtempSync(path.join(os.tmpdir(), "hr-gitea-")); process.env.HOMERAIL_HOME = home; closeDb(); requests = []; status = 200;
    upstream = http.createServer((req, res) => {
      expect(req.headers.authorization).toBe(`token ${token}`); requests.push(req.url!);
      res.writeHead(status, { "Content-Type": "application/json" });
      if (status !== 200) { res.end(JSON.stringify({ error: token })); return; }
      const repo = { name: "repo", full_name: "owner/repo", clone_url: `${endpoint}/owner/repo.git`, default_branch: "main", token, description: token };
      const data = req.url!.includes("/branches") ? [{ name: "main", commit: { id: "abcd" }, token }] : req.url!.includes("/user/repos") ? [repo] : req.url!.includes("/repos/") ? repo : { login: "owner", full_name: "Owner", token };
      res.end(JSON.stringify(data));
    });
    endpoint = await listen(upstream); manager = createServer(0, undefined, undefined, false); base = await listen(manager);
  });
  afterEach(async () => { await Promise.all([manager, upstream].map(server => new Promise<void>(resolve => server.close(() => resolve())))); closeDb(); if (previous === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = previous; fs.rmSync(home, { recursive: true, force: true }); });
  async function request(route: string, method = "GET", body?: unknown) {
    const response = await fetch(base + route, { method, headers: { "Content-Type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text(); expect(text).not.toContain(token); return { status: response.status, body: JSON.parse(text) };
  }
  async function register() {
    const result = await request("/api/git-servers", "POST", { name: "Fixture Gitea", platform_type: "gitea", api_endpoint: endpoint + "/api/v1", token });
    expect(result.status).toBe(201); expect(result.body.data.token_masked).toBeTruthy(); expect(result.body.data.token).toBeUndefined(); return result.body.data.server_id as string;
  }
  it("registers, verifies, paginates repos/branches, updates and clears settings without exposing tokens", async () => {
    const id = await register(), route = `/api/git-servers/${id}`;
    expect((await request(route + "/verify", "POST", {})).body.data).toMatchObject({ valid: true, token_valid: true });
    expect((await request(route + "/user")).body.data.user).toMatchObject({ login: "owner", name: "Owner" });
    const repos = await request(route + "/repos?page=2&per_page=7"); expect(repos.body.data).toMatchObject({ page: 2, per_page: 7, repositories: [{ full_name: "owner/repo", description: "[REDACTED]" }] });
    expect(requests).toContain("/api/v1/user/repos?page=2&limit=7");
    expect((await request(route + "/repository?owner=owner&repo_name=repo")).body.data.repository.full_name).toBe("owner/repo");
    expect((await request(route + "/branches?owner=owner&repo_name=repo&page=3&per_page=9")).body.data.branches).toEqual([{ name: "main", sha: "abcd", is_default: true }]);
    expect(requests).toContain("/api/v1/repos/owner/repo/branches?page=3&limit=9");
    expect((await request(route + "/repos?page=0")).status).toBe(400);
    expect((await request(route, "PUT", { name: "Renamed", git_user_name: "", description: "", is_active: false })).body.data).toMatchObject({ name: "Renamed", git_user_name: null, is_active: false });
    expect((await request(route + "/repos")).status).toBe(409);
    await request(route, "PUT", { is_active: true, token: "" });
    expect((await request(route + "/verify", "POST", {})).status).toBe(401);
    expect((await request(route)).body.data).toMatchObject({ token_masked: "", token_valid: false });
    const rows = getDb().prepare("SELECT data FROM git_servers").all(); expect(JSON.stringify(rows)).not.toContain(token);
    expect((await request(route, "DELETE")).status).toBe(200); expect((await request(route)).status).toBe(404);
  });
  it.each([401, 403, 503])("preserves upstream failure status safely (%s)", async failure => {
    const id = await register(); status = failure;
    expect((await request(`/api/git-servers/${id}/verify`, "POST", {})).status).toBe(failure === 503 ? 502 : failure);
    expect((await request(`/api/git-servers/${id}/repos`)).status).toBe(failure === 503 ? 502 : failure);
    expect((await request(`/api/git-servers/${id}`)).body.data.token_valid).toBe(false);
  });
  it("verifies without saving and binds/clears a repository on the project", async () => {
    expect((await request(`/api/git-servers/verify-token?platform_type=gitea&api_endpoint=${encodeURIComponent(endpoint)}`, "POST", { token })).body.data).toMatchObject({ valid: true, user: { login: "owner" } });
    expect((await request("/api/git-servers")).body.data.servers).toEqual([]);
    const id = await register();
    const project = await request("/api/projects", "POST", { name: "Fixture", git_server_id: id, git_repository: "owner/repo", git_branch: "main" });
    expect(project.status).toBe(201); const projectId = project.body.data.id;
    expect((await request(`/api/projects/${projectId}`)).body.data).toMatchObject({ git_server_id: id, git_repository: "owner/repo" });
    const cleared = await request(`/api/projects/${projectId}`, "PUT", { git_server_id: null, git_repository: null, git_branch: null });
    expect(cleared.body.data.git_server_id || "").toBe(""); expect(cleared.body.data.git_repository || "").toBe("");
    const persisted = await request(`/api/projects/${projectId}`);
    expect(persisted.body.data.git_server_id || "").toBe(""); expect(persisted.body.data.git_repository || "").toBe("");
    expect((await request(`/api/git-servers/${id}/repository`, "PUT", { owner: "owner", repo_name: "repo" })).body.error).toBe("GIT_REPOSITORY_BINDING_PROJECT_REQUIRED");
  });
});
