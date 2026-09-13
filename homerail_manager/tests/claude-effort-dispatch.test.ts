import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DAG_TRANSPORT_FENCE_CAPABILITY } from "homerail-protocol";
import { closeDb } from "../src/persistence/db.js";
import { createSetting, upsertProvider, type ReasoningEffortMap } from "../src/persistence/llm-settings.js";
import { upsertDagWorkflowFromYaml, upsertDagRuntimeProfileFromYaml } from "../src/persistence/dag-workflows.js";
import { loadRunMetadata } from "../src/persistence/store.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { ChangeOrchestrator } from "../src/orchestration/change-orchestrator.js";
import { WsDispatchAdapter } from "../src/orchestration/ws-dispatch-adapter.js";
import { _clearAllDispatches } from "../src/orchestration/dispatch-tracker.js";
import { _clearActiveRuns, requestNodeCorrection } from "../src/runtime/active-runs.js";
import { resolveAgentRuntimeConfig } from "../src/runtime/agent-runtime-resolver.js";
import { registerWorker, _clearWorkers } from "../src/worker/registry.js";
import { _clearNodes } from "../src/node/registry.js";
import { _clearListeners } from "../src/events/bus.js";

interface EffortCase {
  name: string;
  selected?: string;
  mapping?: ReasoningEffortMap | false;
  defaultEffort?: string;
  expected?: string;
}
const cases: EffortCase[] = [
  { name: "scoped medium without a map", selected: "medium", expected: "medium" },
  { name: "model default", mapping: { medium: "medium" }, defaultEffort: "medium", expected: "medium" },
  { name: "scoped effort overrides default", mapping: { medium: "medium", high: "high" }, defaultEffort: "high", selected: "medium", expected: "medium" },
  { name: "selector mapping is forwarded without double mapping", mapping: { balanced: "medium" }, defaultEffort: "balanced", expected: "balanced" },
  { name: "null wire mapping disables effort", mapping: { off: null }, selected: "off", expected: "off" },
  { name: "disabled model map suppresses a scoped selection", mapping: false, selected: "medium" },
  { name: "unset preserves SDK default" },
];

describe("Claude effort through production dispatch configuration", () => {
  let home: string, previousHome: string | undefined;
  beforeEach(() => {
    previousHome = process.env.HOMERAIL_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "hr-claude-effort-"));
    process.env.HOMERAIL_HOME = home;
    closeDb(); _clearActiveRuns(); _clearAllDispatches(); _clearWorkers(); _clearNodes();
    upsertProvider({ id: "effort-fixture", default_model: "fixture-model", anthropic_base_url: "http://127.0.0.1:1" });
  });
  afterEach(() => {
    _clearActiveRuns(); _clearAllDispatches(); _clearWorkers(); _clearNodes(); _clearListeners(); closeDb();
    if (previousHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = previousHome;
    fs.rmSync(home, { recursive: true, force: true });
  });
  function setting(test: EffortCase) {
    return createSetting({ provider_id: "effort-fixture", model_name: "fixture-model", api_key: "fixture-provider-secret", protocol: "anthropic_compatible",
      anthropic_base_url: "http://127.0.0.1:1", is_active: true,
      ...(test.mapping !== undefined ? { reasoning_effort_map: test.mapping } : {}),
      ...(test.defaultEffort ? { default_reasoning_effort: test.defaultEffort } : {}) });
  }

  it.each(cases)("preserves $name in initial and correction Worker messages", test => {
    const model = setting(test);
    for (const surface of ["dag", "manager_agent"] as const) {
      const resolved = resolveAgentRuntimeConfig({ surface, settingId: model.id, agentType: "claude-sdk", reasoningEffort: test.selected });
      expect(resolved.reasoning_effort).toBe(test.expected);
      expect(resolved.reasoning_effort_map).toEqual(test.mapping);
    }
    upsertDagWorkflowFromYaml({ yaml_text: JSON.stringify({ api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "effort-probe", name: "Effort dispatch" }, spec: {
      workspace: { mode: "shared" },
      agents: { probe: { system: "Return one handoff." } },
      nodes: { probe: { kind: "agent", agent: "probe", outputs: { checked: {} } }, done: { kind: "terminal", outcome: "success", inputs: { result: {} } } },
      edges: [{ from: "probe.checked", to: "done.result" }],
    } }) });
    upsertDagRuntimeProfileFromYaml({ workflow_id: "effort-probe", yaml_text: JSON.stringify({ profile_id: "scoped",
      default: { agent_type: "claude-sdk", llm_setting_id: model.id },
      agents: { probe: { ...(test.selected ? { reasoning_effort: test.selected } : {}) } },
    }) });
    const send = vi.fn();
    const idleWorker = () => registerWorker({ worker_id: "effort-worker", project_id: "default", status: "idle", socket: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
      capabilities: [DAG_TRANSPORT_FENCE_CAPABILITY], registered_at: Date.now(), last_heartbeat: Date.now() });
    idleWorker();
    const executor = new GraphExecutor(new WsDispatchAdapter({ provisioner: false }));
    const orchestrator = new ChangeOrchestrator(executor);
    orchestrator.createAndRun({ workflowId: "effort-probe", profile: "scoped", runId: "effort-run" });
    expect(send).toHaveBeenCalledTimes(1);
    expect(requestNodeCorrection("effort-run", "probe", "agent ended without DAG handoff").status).toBe("scheduled");
    idleWorker(); executor.tick("effort-run");
    expect(send).toHaveBeenCalledTimes(2);
    const messages = send.mock.calls.map(([value]) => JSON.parse(String(value)));
    for (const message of messages) {
      expect(message.type).toBe("prompt");
      expect(message.envelope.agentConfig.agent_type).toBe("claude-sdk");
      expect(message.envelope.agentConfig.llm.reasoning_effort).toBe(test.expected);
      expect(message.envelope.agentConfig.llm.reasoning_effort_map).toEqual(test.mapping);
      expect(message.envelope.agentConfig.llm.protocol).toBe("anthropic_compatible");
      expect(message.envelope.credentialProjections ?? []).toEqual([]);
    }
    expect(messages[0].envelope.inputs.correction).toBeUndefined();
    expect(messages[1].envelope.inputs.correction.length).toBeGreaterThan(0);
    expect(JSON.stringify(loadRunMetadata("effort-run"))).not.toContain("fixture-provider-secret");
  });

  it.each([
    { name: "native value", selected: "ultra" },
    { name: "missing selector", selected: "high", mapping: { medium: "medium" } },
    { name: "unsupported wire value", selected: "medium", mapping: { medium: "deep" } },
  ] satisfies EffortCase[])("rejects invalid $name before dispatch", test => {
    const model = setting(test);
    expect(() => resolveAgentRuntimeConfig({ surface: "dag", settingId: model.id, agentType: "claude-sdk", reasoningEffort: test.selected })).toThrow(/Claude SDK.*reasoning effort/);
  });
});
