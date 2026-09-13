import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAG_TRANSPORT_FENCE_CAPABILITY, normalizeWorkspaceAccess, type DagWorkspaceAccess } from "homerail-protocol";
import { closeDb } from "../src/persistence/db.js";
import { createSetting, upsertProvider } from "../src/persistence/llm-settings.js";
import { upsertDagWorkflowFromYaml, upsertDagRuntimeProfileFromYaml } from "../src/persistence/dag-workflows.js";
import { compileWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { WsDispatchAdapter } from "../src/orchestration/ws-dispatch-adapter.js";
import { _clearAllDispatches } from "../src/orchestration/dispatch-tracker.js";
import { _clearActiveRuns } from "../src/runtime/active-runs.js";
import { registerWorker, _clearWorkers } from "../src/worker/registry.js";
import { registerNode, getNode, _clearNodes } from "../src/node/registry.js";
import { resolveLifecycleResponse } from "../src/node/lifecycle-request.js";
import { _clearListeners } from "../src/events/bus.js";
import { handleLifecycleRequest, type LifecycleRequest } from "../../homerail_node/src/control-plane/lifecycle-handler.js";
import { MockProvider } from "../../homerail_node/src/providers/mock-provider.js";
import { snapshotWorkspace, verifyWorkspacePolicy } from "../../homerail_worker/src/workspace-policy.js";

const plugin = "source/android-shell/plugins/example";
const vendor = "source/android-shell/vendor/example";
const access: DagWorkspaceAccess = {
  writable_paths: [plugin, `${vendor}/lib/host-plugin.js`, `${vendor}/ANDROID-PATCHES.md`],
  readonly_paths: ["input", "source/docs", `${plugin}/protected.txt`],
  git_metadata_read_only: true,
};
function workflow(policy: DagWorkspaceAccess) {
  return JSON.stringify({ api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "mount-proof", name: "Mount proof" }, spec: {
    workspace: { mode: "shared" }, agents: { edit: { system: "No model will be called." } },
    nodes: { edit: { kind: "agent", agent: "edit", workspace_access: policy, outputs: { checked: {} } }, done: { kind: "terminal", outcome: "success", inputs: { result: {} } } },
    edges: [{ from: "edit.checked", to: "done.result" }],
  } });
}

describe("workspace access across real Manager dispatch and Node lifecycle", () => {
  let home: string, previousHome: string | undefined, root: string;
  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hr-mount-chain-"));
    process.env.HOMERAIL_HOME = home;
    closeDb(); _clearActiveRuns(); _clearAllDispatches(); _clearWorkers(); _clearNodes();
    root = path.join(home, "workspace", "mount-run");
    for (const name of ["input/spec.json", "AGENTS.md", ".git/config", "receipts/result.json", "source/AGENTS.md", "source/docs/design.md",
      `${plugin}/code.js`, `${plugin}/AGENTS.md`, `${plugin}/.git/config`, `${plugin}/receipts/result.json`, `${plugin}/protected.txt`,
      `${vendor}/lib/host-plugin.js`, `${vendor}/lib/neighbor.js`, `${vendor}/ANDROID-PATCHES.md`]) {
      fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
      fs.writeFileSync(path.join(root, name), "original\n");
    }
  });
  afterEach(() => {
    _clearActiveRuns(); _clearAllDispatches(); _clearWorkers(); _clearNodes(); _clearListeners(); closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });

  async function provision(policy: DagWorkspaceAccess) {
    const provider = new MockProvider();
    const workerSend = vi.fn();
    const requests: LifecycleRequest[] = [];
    const responses: Array<{ status: string; error?: unknown }> = [];
    let workerId = "";
    const socket = { readyState: WebSocket.OPEN, send: (raw: string) => {
      const request = JSON.parse(raw) as LifecycleRequest;
      requests.push(request);
      if (request.operation === "create") workerId = (request.spec.env as Record<string, string>).HOMERAIL_WORKER_ID;
      void handleLifecycleRequest(request, provider, response => {
        responses.push(response);
        resolveLifecycleResponse(getNode("mount-node")!, response.request_id, response.status, response.resource_data, response.error);
      });
    } } as unknown as WebSocket;
    registerNode({ node_id: "mount-node", project_id: "default", status: "connected", socket, capabilities: ["docker-cli"],
      registered_at: Date.now(), last_heartbeat: Date.now(), pending_requests: new Map() });
    // An idle generic Worker must not short-circuit scoped provisioning.
    const genericSend = vi.fn();
    registerWorker({ worker_id: "generic", project_id: "default", status: "idle", socket: { readyState: WebSocket.OPEN, send: genericSend } as unknown as WebSocket,
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY], registered_at: Date.now(), last_heartbeat: Date.now() });
    upsertProvider({ id: "mount-fixture", default_model: "fixture", anthropic_base_url: "http://127.0.0.1:1" });
    const model = createSetting({ provider_id: "mount-fixture", model_name: "fixture", api_key: "local-no-key", protocol: "anthropic_compatible", anthropic_base_url: "http://127.0.0.1:1", is_active: true });
    expect(compileWorkflowSource(workflow(policy)).diagnostics).toEqual([]);
    upsertDagWorkflowFromYaml({ yaml_text: workflow(policy) });
    upsertDagRuntimeProfileFromYaml({ workflow_id: "mount-proof", yaml_text: JSON.stringify({ profile_id: "local", default: { agent_type: "claude-sdk", llm_setting_id: model.id, reasoning_effort: "medium" } }) });
    const adapter = new WsDispatchAdapter({ managerBaseUrl: "http://127.0.0.1:1", provisioner: { runtimeStatusFn: async () => {
      registerWorker({ worker_id: workerId, project_id: "default", status: "idle", socket: { readyState: WebSocket.OPEN, send: workerSend } as unknown as WebSocket,
        capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY], registered_at: Date.now(), last_heartbeat: Date.now() });
      return { worker_ids: [workerId] };
    } } });
    new ChangeOrchestrator(new GraphExecutor(adapter)).createAndRun({ workflowId: "mount-proof", profile: "local", runId: "mount-run" });
    await vi.waitFor(() => expect(responses.length).toBeGreaterThan(0));
    expect(genericSend).not.toHaveBeenCalled();
    if (responses[0].status === "success") await vi.waitFor(() => expect(workerSend).toHaveBeenCalledOnce());
    return { provider, requests, responses, workerSend };
  }

  it("preserves the policy through profile resolution, provisioning, wire lifecycle, Node mounts and Worker verification", async () => {
    const result = await provision(access);
    expect(result.responses.every(r => r.status === "success")).toBe(true);
    const config = [...result.provider.containers.values()][0].config;
    expect(result.requests[0].spec.workspace_read_only).toBe(true);
    expect(result.requests[0].spec.workspace_access).toEqual(access);
    expect(result.requests[0].spec.workspace_writable_subpath).toBeUndefined();
    const envelope = JSON.parse(result.workerSend.mock.calls[0][0]).envelope;
    expect(envelope.workspaceAccess).toEqual(access);
    expect(envelope.agentConfig.llm.reasoning_effort).toBe("medium");
    const modes = Object.fromEntries(config.mounts!.map(m => [m.container, m.mode]));
    expect(modes["/workspace"]).toBe("ro");
    expect(modes["/workspace/input"]).toBe("ro");
    for (const name of access.writable_paths) expect(modes[`/workspace/${name}`]).toBe("rw");
    for (const name of ["AGENTS.md", ".git", "receipts", "protected.txt"]) expect(modes[`/workspace/${plugin}/${name}`]).toBe("ro");
    expect(config.mounts!.some(m => m.host.includes("docker.sock"))).toBe(false);
    expect(config.securityOpts).toBeUndefined();
    const before = snapshotWorkspace(root, access);
    fs.appendFileSync(path.join(root, `${vendor}/lib/host-plugin.js`), "allowed\n");
    fs.writeFileSync(path.join(root, `${plugin}/new.js`), "allowed\n");
    expect(verifyWorkspacePolicy(before, snapshotWorkspace(root, access), access).valid).toBe(true);
    fs.appendFileSync(path.join(root, `${plugin}/AGENTS.md`), "forbidden\n");
    expect(verifyWorkspacePolicy(before, snapshotWorkspace(root, access), access).protected_changes).toContain(`${plugin}/AGENTS.md`);

    // Opt-in standalone Docker proof, using the mounts produced above. Never
    // connects a model/Manager or uses a deployed runtime, network, or credential.
    const image = process.env.HOMERAIL_TEST_DOCKER_IMAGE;
    if (image) {
      const args = ["run", "--rm", "--pull=never", "--network=none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only"];
      for (const mount of config.mounts!) args.push("--mount", `type=bind,src=${mount.host},dst=${mount.container}${mount.mode === "ro" ? ",readonly" : ""}`);
      const allowed = [`${plugin}/docker-created.js`, `${vendor}/lib/host-plugin.js`, `${vendor}/ANDROID-PATCHES.md`];
      const denied = ["root-new", "input/spec.json", "AGENTS.md", ".git/config", "receipts/result.json", "source/AGENTS.md", "source/docs/design.md",
        `${plugin}/AGENTS.md`, `${plugin}/.git/config`, `${plugin}/receipts/result.json`, `${plugin}/protected.txt`, `${vendor}/lib/neighbor.js`, `${vendor}/unapproved-new`];
      const script = ["set -eu", ...allowed.map(n => `echo allowed >> /workspace/${n}; echo 'WRITE_OK ${n}'`),
        ...denied.map(n => `if (echo forbidden >> /workspace/${n}) 2>/dev/null; then echo 'UNEXPECTED_WRITE ${n}'; exit 1; else echo 'WRITE_DENIED ${n}'; fi`),
        `echo replacement > /workspace/${plugin}/replacement`,
        `if mv /workspace/${plugin}/replacement /workspace/${vendor}/lib/host-plugin.js 2>/dev/null; then echo UNEXPECTED_FILE_RENAME; exit 1; else echo FILE_BIND_RENAME_DENIED; fi`,
        `if rm /workspace/${plugin}/AGENTS.md 2>/dev/null; then exit 1; else echo PROTECTED_UNLINK_DENIED; fi`,
        "test ! -e /var/run/docker.sock", "echo DOCKER_PERMISSION_PROOF_PASSED"].join("\n");
      const proof = spawnSync("docker", [...args, image, "sh", "-c", script], { encoding: "utf8", timeout: 30_000 });
      if (process.env.HOMERAIL_TEST_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.HOMERAIL_TEST_EVIDENCE_DIR, "docker-permissions.log"), proof.stdout + proof.stderr);
      expect(proof.error).toBeUndefined();
      expect(proof.status, proof.stdout + proof.stderr).toBe(0);
    }
  });

  it.each(["missing", "symlink", "ancestor-symlink", "hardlink", "protected-missing", "readonly-alias", "input-symlink", "escaping-symlink", "workspace-root-symlink"])("rejects %s before provider.create, without a writable root fallback", async shape => {
    if (shape === "workspace-root-symlink") {
      fs.renameSync(root, path.join(home, "outside-root"));
      fs.symlinkSync(path.join(home, "outside-root"), root);
    }
    if (shape === "readonly-alias") {
      fs.unlinkSync(path.join(root, "AGENTS.md"));
      fs.symlinkSync(path.join(root, `${plugin}/code.js`), path.join(root, "AGENTS.md"));
    }
    if (shape === "input-symlink") {
      fs.rmSync(path.join(root, "input"), { recursive: true });
      fs.symlinkSync(path.join(root, plugin), path.join(root, "input"));
    }
    if (shape === "escaping-symlink") fs.symlinkSync(home, path.join(root, "outside"));
    if (shape === "missing") fs.unlinkSync(path.join(root, `${vendor}/ANDROID-PATCHES.md`));
    if (shape === "symlink") fs.symlinkSync(path.join(root, "AGENTS.md"), path.join(root, `${plugin}/alias`));
    if (shape === "ancestor-symlink") {
      fs.renameSync(path.join(root, vendor), path.join(root, "moved-vendor"));
      fs.symlinkSync(path.join(root, "moved-vendor"), path.join(root, vendor));
    }
    if (shape === "hardlink") fs.linkSync(path.join(root, "AGENTS.md"), path.join(root, `${plugin}/alias`));
    if (shape === "protected-missing") fs.unlinkSync(path.join(root, `${plugin}/protected.txt`));
    const result = await provision(access);
    expect(result.responses[0].status).toBe("error");
    expect(result.provider.containers.size).toBe(0);
    expect(result.workerSend).not.toHaveBeenCalled();
    if (shape === "workspace-root-symlink") expect(fs.existsSync(path.join(home, "outside-root", ".homerail-runtime"))).toBe(false);
  });

  it("supports an explicitly selected minimal parent with read-only neighbors and atomic rename", async () => {
    fs.unlinkSync(path.join(root, `${vendor}/ANDROID-PATCHES.md`));
    const parentAccess = {
      writable_paths: [plugin, vendor],
      readonly_paths: ["input", `${vendor}/lib/neighbor.js`, `${plugin}/protected.txt`],
    };
    const result = await provision(parentAccess);
    expect(result.responses[0].status).toBe("success");
    const config = [...result.provider.containers.values()][0].config;
    expect(config.mounts).toEqual(expect.arrayContaining([
      expect.objectContaining({ container: "/workspace", mode: "ro" }),
      expect.objectContaining({ container: `/workspace/${vendor}`, mode: "rw" }),
      expect.objectContaining({ container: `/workspace/${vendor}/lib/neighbor.js`, mode: "ro" }),
    ]));
    const before = snapshotWorkspace(root, parentAccess);
    fs.writeFileSync(path.join(root, `${vendor}/ANDROID-PATCHES.md`), "new file");
    expect(verifyWorkspacePolicy(before, snapshotWorkspace(root, parentAccess), parentAccess).valid).toBe(true);
    const image = process.env.HOMERAIL_TEST_DOCKER_IMAGE;
    if (image) {
      fs.unlinkSync(path.join(root, `${vendor}/ANDROID-PATCHES.md`));
      const args = ["run", "--rm", "--pull=never", "--network=none", "--user", `${process.getuid!()}:${process.getgid!()}`, "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only"];
      for (const mount of config.mounts!) args.push("--mount", `type=bind,src=${mount.host},dst=${mount.container}${mount.mode === "ro" ? ",readonly" : ""}`);
      const script = `set -eu
        echo new > /workspace/${vendor}/ANDROID-PATCHES.md
        echo replacement > /workspace/${vendor}/lib/temporary
        mv /workspace/${vendor}/lib/temporary /workspace/${vendor}/lib/host-plugin.js
        test "$(cat /workspace/${vendor}/lib/host-plugin.js)" = replacement
        if (echo forbidden > /workspace/${vendor}/lib/neighbor.js) 2>/dev/null; then exit 1; fi
        if rm /workspace/${vendor}/lib/neighbor.js 2>/dev/null; then exit 1; fi
        if mv /workspace/${vendor}/lib /workspace/${vendor}/renamed-lib 2>/dev/null; then echo UNEXPECTED_PROTECTED_PARENT_RENAME; exit 1; fi
        if (echo forbidden > /workspace/source/AGENTS.md) 2>/dev/null; then exit 1; fi
        if (echo forbidden > /workspace/.git/config) 2>/dev/null; then exit 1; fi
        if (echo forbidden > /workspace/input/spec.json) 2>/dev/null; then exit 1; fi
        if (echo forbidden > /workspace/root-new) 2>/dev/null; then exit 1; fi
        echo MINIMAL_PARENT_CREATE_RENAME_AND_PROTECTIONS_PASSED`;
      const proof = spawnSync("docker", [...args, image, "sh", "-c", script], { encoding: "utf8", timeout: 30_000 });
      if (process.env.HOMERAIL_TEST_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.HOMERAIL_TEST_EVIDENCE_DIR, "docker-parent-permissions.log"), proof.stdout + proof.stderr);
      expect(proof.error).toBeUndefined();
      expect(proof.status, proof.stdout + proof.stderr).toBe(0);
    }
  });

  it.each([undefined, "root-rw", "legacy-conflict"])("rejects malformed or contradictory lifecycle policy %s", async shape => {
    const provider = new MockProvider();
    const responses: Array<{ status: string }> = [];
    await handleLifecycleRequest({ type: "lifecycle_request", request_id: "reject", resource_type: "worker", operation: "create", spec: {
      workspace_id: "mount-run", workspace: { mode: "shared" },
      workspace_read_only: shape !== "root-rw",
      workspace_access: shape === undefined ? { writable_paths: "source" } : access,
      ...(shape === "legacy-conflict" ? { workspace_writable_subpath: "source" } : {}),
    } }, provider, r => responses.push(r));
    expect(responses[0].status).toBe("error");
    expect(provider.containers.size).toBe(0);
  });

  it.each([ ["."], ["/tmp/escape"], ["../escape"], ["C:\\escape"], ["input/data"], ["repo/.git"], ["repo/AGENTS.md"], ["receipts"], ["repo", "repo/src"], ["repo", "./repo/"] ].map(writable => ({ writable })))("rejects invalid policy $writable in validation and Worker policy", ({ writable }) => {
    const policy = { writable_paths: writable };
    expect(() => normalizeWorkspaceAccess(policy)).toThrow();
    expect(compileWorkflowSource(workflow(policy)).diagnostics.some(d => d.severity === "error")).toBe(true);
    expect(() => snapshotWorkspace(root, policy)).toThrow();
  });
  it("rejects a read-only ancestor but permits narrower read-only protections", () => {
    const policy = { writable_paths: [plugin], readonly_paths: ["source"] };
    expect(() => normalizeWorkspaceAccess(policy)).toThrow(/read-only ancestor/);
    expect(compileWorkflowSource(workflow(policy)).diagnostics.some(d => d.severity === "error")).toBe(true);
    expect(() => snapshotWorkspace(root, policy)).toThrow(/read-only ancestor/);
  });

  it("normalizes legacy-compatible spelling consistently and bounds grants", () => {
    expect(normalizeWorkspaceAccess({ writable_paths: ["./source\\android-shell/plugins/example/"] }).writable_paths).toEqual([plugin]);
    expect(() => normalizeWorkspaceAccess({ writable_paths: Array.from({ length: 33 }, (_, i) => `dir-${i}`) })).toThrow(/at most 32/);
  });

  it("does not hide newly created excluded Git roots from Worker verification", () => {
    fs.rmSync(path.join(root, plugin, ".git"), { recursive: true });
    const before = snapshotWorkspace(root, access);
    fs.mkdirSync(path.join(root, plugin, ".git"));
    const result = verifyWorkspacePolicy(before, snapshotWorkspace(root, access), access);
    expect(result.valid).toBe(false);
    expect(result.protected_changes).toContain(`${plugin}/.git`);
    expect(result.before_hash).not.toBe(result.after_hash);
  });
});
