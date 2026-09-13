import type { GitServerRecord } from "../persistence/git-servers.js";

export class GitServerUpstreamError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function giteaApiRoot(endpoint: string): string {
  const url = new URL(endpoint);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Git server endpoint must be an HTTP(S) URL without credentials, query or fragment");
  }
  return url.href.replace(/\/$/, "").replace(/\/api\/v1$/, "") + "/api/v1";
}

export async function giteaRequest(server: Pick<GitServerRecord, "platform_type" | "api_endpoint" | "token">, route: string): Promise<any> {
  if (server.platform_type !== "gitea") throw new GitServerUpstreamError(400, "This operation currently supports Gitea only");
  if (!server.token) throw new GitServerUpstreamError(401, "Git server token is missing");
  try {
    const response = await fetch(giteaApiRoot(server.api_endpoint) + route, {
      headers: { Authorization: `token ${server.token}`, Accept: "application/json" },
      redirect: "error", signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const status = [401, 403, 404, 429].includes(response.status) ? response.status : 502;
      throw new GitServerUpstreamError(status, `Git server request failed (HTTP ${status})`);
    }
    // Never return provider error bodies or unknown fields (they can contain
    // credentials). Redact reflected token values before projecting public data.
    const redact = (value: unknown): unknown => {
      if (typeof value === "string") return value.split(server.token).join("[REDACTED]");
      if (Array.isArray(value)) return value.map(redact);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
      return value;
    };
    return redact(await response.json());
  } catch (error) {
    if (error instanceof GitServerUpstreamError) throw error;
    throw new GitServerUpstreamError(502, "Git server request failed");
  }
}

export function gitUser(body: any) {
  return { login: String(body.login ?? ""), name: String(body.full_name ?? body.name ?? ""), email: String(body.email ?? ""),
    id: typeof body.id === "number" ? body.id : 0, avatar_url: String(body.avatar_url ?? ""), html_url: String(body.html_url ?? "") };
}

export function gitRepository(body: any) {
  return { name: String(body.name ?? ""), full_name: String(body.full_name ?? ""), description: String(body.description ?? ""),
    clone_url: String(body.clone_url ?? ""), ssh_url: String(body.ssh_url ?? ""), html_url: String(body.html_url ?? ""),
    default_branch: String(body.default_branch ?? ""), private: body.private === true, language: typeof body.language === "string" ? body.language : null };
}

export function gitPagination(params: URLSearchParams): { page: number; per_page: number } {
  const page = Number(params.get("page") ?? 1); const per_page = Number(params.get("per_page") ?? 30);
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(per_page) || per_page < 1 || per_page > 100) {
    throw new Error("page must be a positive integer and per_page must be between 1 and 100");
  }
  return { page, per_page };
}
