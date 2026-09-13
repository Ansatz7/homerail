import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { cmdInject } from "../src/commands/inject.js";
import { HomeRailClient, HomeRailHttpError } from "../src/client.js";
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

const receipt = { success: false, message: "Legacy inject is unsupported", error: "DAG_LEGACY_INJECT_UNSUPPORTED",
  data: { delivered: false, injected: false, run_id: "run", node_id: "node", delivery_gap: "Use the tracked run commands API" } };

async function serve(status: number, body: unknown) {
  const requests: Array<{ method?: string; url?: string; body: unknown }> = [];
  const server = createServer((request, response) => {
    let data = "";
    request.on("data", chunk => { data += chunk; });
    request.on("end", () => {
      requests.push({ method: request.method, url: request.url, body: data ? JSON.parse(data) : undefined });
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}
describe("legacy inject receipt", () => {
  it.each([true, false])("fails even on HTTP success unless delivery is confirmed (success=%s)", async success => {
    const response = { success, message: "legacy response", data: { injected: false, delivered: false, delivery_gap: "unsupported" } };
    const client = { inject: vi.fn(async () => response) } as unknown as HomeRailClient;
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await cmdInject(client, "run", "node", "feedback", "inbox", true)).toBe(1);
    expect(JSON.parse(log.mock.calls[0][0])).toEqual(response);
  });

  it.each([true, false])("prints the real HTTP 409 receipt with exit 1 (json=%s)", async json => {
    const { baseUrl, requests } = await serve(409, receipt);
    const client = new HomeRailClient({ baseUrl, adminToken: "", mutationToken: "" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await cmdInject(client, "run", "node", "feedback", "inbox", json)).toBe(1);
    expect(requests).toEqual([{ method: "POST", url: "/api/runs/run/inject", body: { node_id: "node", instruction: "feedback", mode: "inbox" } }]);
    if (json) expect(JSON.parse(log.mock.calls[0][0])).toEqual(receipt);
    else expect(error.mock.calls.flat().join("\n")).toContain("POST /api/runs/:id/commands");
  });

  it.each([401, 403, 409, 500])("keeps unrelated HTTP %s failures as errors", async status => {
    const { baseUrl } = await serve(status, { success: false, error: "OTHER_ERROR", message: "rejected" });
    const client = new HomeRailClient({ baseUrl, adminToken: "", mutationToken: "" });
    await expect(client.inject("run", "node", "feedback", "inbox")).rejects.toBeInstanceOf(HomeRailHttpError);
  });

  it("does not apply receipt handling to other endpoints or contradictory delivery claims", async () => {
    const { baseUrl } = await serve(409, receipt);
    const client = new HomeRailClient({ baseUrl, adminToken: "", mutationToken: "" });
    await expect(client.post("/api/runs/run/commands", {})).rejects.toBeInstanceOf(HomeRailHttpError);
    const contradictory = await serve(409, { ...receipt, data: { delivered: true } });
    await expect(new HomeRailClient({ baseUrl: contradictory.baseUrl, adminToken: "", mutationToken: "" }).inject("run", "node", "feedback", "inbox"))
      .rejects.toBeInstanceOf(HomeRailHttpError);
  });

  it("redacts reflected credentials in structured rejection receipts", async () => {
    const admin = "private-fixture-admin", mutation = "private-fixture-mutation";
    const { baseUrl } = await serve(409, { ...receipt, message: admin, data: { ...receipt.data, delivery_gap: mutation, nested: { api_key: "private-provider-value", detail: `Bearer ${admin}` } } });
    const client = new HomeRailClient({ baseUrl, adminToken: admin, mutationToken: mutation });
    const output = JSON.stringify(await client.inject("run", "node", "feedback", "inbox"));
    for (const secret of [admin, mutation, "private-provider-value"]) expect(output).not.toContain(secret);
    expect(output).toContain("REDACTED");
  });

  it("the actual CLI process emits JSON instead of an unhandled rejection", async () => {
    const { baseUrl } = await serve(409, receipt);
    const home = mkdtempSync(join(tmpdir(), "hr-inject-process-"));
    try {
      const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("../src/cli.ts", import.meta.url)), "--base-url", baseUrl, "--json", "inject", "run", "node", "feedback", "--mode", "inbox"], {
          env: { ...process.env, HOMERAIL_HOME: home, HOMERAIL_MANAGER_ADMIN_TOKEN: "", HOMERAIL_DAG_MUTATION_TOKEN: "" },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "", stderr = "";
        const timer = setTimeout(() => { child.kill(); reject(new Error("CLI did not exit")); }, 10_000);
        child.stdout.on("data", chunk => { stdout += chunk; });
        child.stderr.on("data", chunk => { stderr += chunk; });
        child.on("error", error => { clearTimeout(timer); reject(error); });
        child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
      });
      expect(result.code).toBe(1);
      expect(JSON.parse(result.stdout)).toEqual(receipt);
      expect(result.stderr).toBe("");
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
