import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseWorkflowSource } from "../src/orchestration/workflow-spec-v1.js";
import { createDAGRun, handoff, stalledLoopDiagnostic } from "../src/orchestration/dag-engine.js";
import { GraphExecutor } from "../src/orchestration/graph-executor.js";
import { _clearActiveRuns, getActiveRun, handoffActiveRun, recoverAllActiveRuns, seedInitialPrompt } from "../src/runtime/active-runs.js";
import { closeDb } from "../src/persistence/db.js";
import { _clearListeners } from "../src/events/bus.js";

// Shipped Auto Fix topology, with deterministic stand-ins for agents and
// commands. No repository clone, external credential, or PR publication.
function fixture(maxIterations = 4) {
  const source = YAML.parse(fs.readFileSync(path.resolve("../assets/orchestrations/auto-fix.yaml.template"), "utf8"));
  const ids = new Set(["sanitize_issue", "initialize_review_cycle", "review_cycle", "review_phase", "review_correctness_initial", "review_regression_initial", "review_adversarial_initial", "aggregate_reviews", "revise", "revision_gate", "collect_revised_patch", "prepare_next_review", "extract_approved_candidate", "arbitrate", "arbitration_gate", "publish", "finalize_publication", "done", "review_cycle_exhausted", "review_cycle_rejected"]);
  for (const [id, node] of Object.entries<any>(source.spec.nodes)) if (node.kind === "terminal") ids.add(id);
  const nodes: Record<string, any> = {};
  for (const [id, original] of Object.entries<any>(source.spec.nodes)) {
    if (!ids.has(id)) continue;
    const gateway = ["while", "condition", "terminal"].includes(original.kind);
    nodes[id] = { kind: gateway ? original.kind : "agent", ...(gateway ? { config: original.config, outcome: original.outcome } : { agent: "worker" }),
      inputs: Object.fromEntries(Object.keys(original.inputs ?? {}).map(port => [port, {}])), outputs: Object.fromEntries(Object.keys(original.outputs ?? {}).map(port => [port, {}])), ...(original.depends_on ? { depends_on: original.depends_on } : {}) };
  }
  for (const node of Object.values(nodes)) if (node.kind === "terminal") delete node.outputs;
  nodes.review_cycle.config.max_iterations = maxIterations;
  const edges = source.spec.edges.filter((edge: any) => ids.has(edge.from.split(".")[0]) && ids.has(edge.to.split(".")[0]));
  nodes.audit = { kind: "agent", agent: "worker", depends_on: ["review_correctness_initial"], outputs: { done: {} } };
  nodes.audit_done = { kind: "terminal", outcome: "success", inputs: { result: {} } };
  edges.push({ from: "audit.done", to: "audit_done.result" });
  const parsed = parseWorkflowSource(JSON.stringify({ api_version: "homerail.ai/v1", kind: "Workflow", metadata: { id: "loop-inputs", name: "Loop inputs" }, spec: { agents: { worker: { system: "Return fixture data." } }, nodes, edges } }));
  parsed.meta.agents.worker.agent_type = "deterministic";
  return parsed;
}

describe("Auto Fix loop input retention", () => {
  let home: string; let oldHome: string | undefined;
  beforeEach(() => { oldHome = process.env.HOMERAIL_HOME; home = fs.mkdtempSync(path.join(os.tmpdir(), "hr-loop-inputs-")); process.env.HOMERAIL_HOME = home; closeDb(); _clearActiveRuns(); });
  afterEach(() => { _clearActiveRuns(); closeDb(); _clearListeners(); if (oldHome === undefined) delete process.env.HOMERAIL_HOME; else process.env.HOMERAIL_HOME = oldHome; fs.rmSync(home, { recursive: true, force: true }); });

  it.each([false, true])("retains seed through revision and three approvals (recover=%s)", (recover) => {
    const executor = new GraphExecutor({ dispatch: () => ({ status: "dispatched", targetType: "fake", targetId: "fixture" }) }); executor.createRun("loop", fixture());
    const seed = { issue: "immutable external issue" };
    let phase = "review", reviews = 0, revised = false, recovered = false;
    const counts: Record<string, number> = {};
    for (let step = 0; step < 80; step++) {
      executor.tick("loop"); const run = getActiveRun("loop")!;
      if (run.status !== "active") break;
      const running = [...run.dagRun.nodeStates].filter(([id, state]) => state === "RUNNING" && !run.dagRun.loopSources.has(id));
      expect(running.length, JSON.stringify(Object.fromEntries(run.dagRun.nodeStates))).toBeGreaterThan(0);
      for (const [id] of running) {
        counts[id] = (counts[id] ?? 0) + 1; const box = run.dagRun.mailboxes.get(id)!;
        if (["revise", "arbitrate", "publish", "finalize_publication"].includes(id) || id.startsWith("review_")) expect(box.get("issue"), id).toEqual([seed]);
        let port: string; let value: any = {};
        switch (id) {
          case "sanitize_issue": port = "sanitized"; value = seed; break;
          case "initialize_review_cycle": port = "initialized"; value = { status: "reviewing", phase }; break;
          case "aggregate_reviews":
            for (const role of ["correctness", "regression", "adversarial"]) expect(box.get(role)).toEqual([{ verdict: revised ? "approve" : "reject", revision: revised ? 1 : 0 }]);
            reviews++; phase = revised ? "done" : "revise"; port = "next"; value = { status: revised ? "approved" : "reviewing", phase }; break;
          case "revise": revised = true; port = "reported"; value = { status: "fixed" }; break;
          case "collect_revised_patch": port = "patched"; break;
          case "prepare_next_review": port = "next"; value = { status: "reviewing", phase: "review" }; break;
          case "extract_approved_candidate": port = "patched"; break;
          case "arbitrate": port = "arbitrated"; value = { verdict: "approve" }; break;
          case "publish": port = "summarized"; break;
          case "finalize_publication": port = "published"; break;
          case "audit": port = "done"; break;
          default: port = "voted"; value = { verdict: revised ? "approve" : "reject", revision: revised ? 1 : 0 };
        }
        handoffActiveRun("loop", id, port, value);
      }
      if (recover && phase === "revise" && !recovered) { _clearActiveRuns(); closeDb(); expect(recoverAllActiveRuns()).toMatchObject({ recovered: ["loop"], failed: [] }); recovered = true; }
    }
    expect(getActiveRun("loop")?.status, JSON.stringify({ counts, counters: getActiveRun("loop")?.counters, states: Object.fromEntries(getActiveRun("loop")!.dagRun.nodeStates) })).toBe("completed"); expect(reviews).toBe(2);
    expect(counts).toMatchObject({ sanitize_issue: 1, revise: 1, arbitrate: 1, publish: 1, finalize_publication: 1, audit: 2 }); expect(recovered).toBe(recover);
  });

  it("diagnoses a closed stalled loop without misclassifying external waits", () => {
    const parsed = fixture(); const run = createDAGRun(parsed, "stalled");
    for (const id of run.nodeStates.keys()) run.nodeStates.set(id, "SKIPPED");
    run.nodeStates.set("review_cycle", "RUNNING"); run.nodeStates.set("aggregate_reviews", "PENDING");
    expect(stalledLoopDiagnostic(run)).toContain("DAG_LOOP_STALLED");
    for (const state of ["RUNNING", "WAITING_FOR_APPROVAL", "WAITING_FOR_COMMAND", "READY"] as const) {
      run.nodeStates.set("revise", state); expect(stalledLoopDiagnostic(run)).toBeUndefined();
    }
  });

  it("fails at the bounded iteration limit", () => {
    const executor = new GraphExecutor({ dispatch: () => ({ status: "dispatched", targetType: "fake", targetId: "fixture" }) });
    executor.createRun("bounded", fixture(1));
    handoffActiveRun("bounded", "sanitize_issue", "sanitized", {});
    handoffActiveRun("bounded", "initialize_review_cycle", "initialized", { status: "reviewing", phase: "review" });
    executor.tick("bounded");
    for (const role of ["correctness", "regression", "adversarial"]) handoffActiveRun("bounded", `review_${role}_initial`, "voted", { verdict: "reject" });
    executor.tick("bounded"); handoffActiveRun("bounded", "audit", "done", {});
    handoffActiveRun("bounded", "aggregate_reviews", "next", { status: "reviewing", phase: "revise" });
    executor.tick("bounded"); expect(getActiveRun("bounded")?.status).toBe("failed");
    expect(getActiveRun("bounded")?.counters.gateway_iterations.review_cycle).toBe(1);
  });

  it("retains unambiguous external inputs from legacy snapshots", () => {
    const run = createDAGRun(fixture(), "legacy");
    handoff(run, "sanitize_issue", "sanitized", "seed");
    delete run.routedInputs;
    handoff(run, "review_cycle", "continue", "round1");
    handoff(run, "review_phase", "revise", "old-feedback");
    handoff(run, "review_cycle", "continue", "round2");
    handoff(run, "review_phase", "revise", "new-feedback");
    expect(run.mailboxes.get("revise")?.get("issue")).toEqual(["seed"]);
    expect(run.mailboxes.get("revise")?.get("state")).toEqual(["new-feedback"]);
    expect(run.nodeStates.get("revise")).toBe("READY");
  });

  it("fails explicitly on ambiguous legacy merged inputs rather than replaying stale feedback", () => {
    const parsed = fixture();
    parsed.graph.edges.find(e => e.from_node === "sanitize_issue" && e.to_node === "revise" && e.label !== "after_dep")!.to_port = "state";
    const run = createDAGRun(parsed, "legacy-mixed");
    handoff(run, "sanitize_issue", "sanitized", "seed");
    delete run.routedInputs;
    handoff(run, "review_cycle", "continue", "round1");
    handoff(run, "review_phase", "revise", "old-feedback");
    expect(() => handoff(run, "review_cycle", "continue", "round2")).toThrow("DAG_LOOP_INPUT_PROVENANCE_MISSING");
  });

  it("retains explicitly bound run input through loop resets", () => {
    const run = createDAGRun(fixture(), "run-input");
    seedInitialPrompt(run, '{"immutable":true}', [{ node: "review_phase", port: "context" }]);
    handoff(run, "review_cycle", "continue", "round1");
    handoff(run, "review_phase", "revise", "old-feedback");
    handoff(run, "review_cycle", "continue", "round2");
    expect(run.mailboxes.get("review_phase")?.get("context")).toEqual([{ immutable: true }]);
    expect(run.mailboxes.get("review_phase")?.get("state")).toEqual(["round2"]);
  });

  it("separates external and old-round values sharing an input port", () => {
    const parsed = fixture();
    parsed.graph.edges.find(e => e.from_node === "sanitize_issue" && e.to_node === "revise" && e.label !== "after_dep")!.to_port = "state";
    const run = createDAGRun(parsed, "mixed");
    handoff(run, "sanitize_issue", "sanitized", "seed"); handoff(run, "review_cycle", "continue", "round1"); handoff(run, "review_phase", "revise", "old-feedback");
    handoff(run, "review_cycle", "continue", "round2"); handoff(run, "review_phase", "revise", "new-feedback");
    expect(run.mailboxes.get("revise")?.get("state")).toEqual(["seed", "new-feedback"]); expect(run.nodeStates.get("revise")).toBe("READY");
  });
});
