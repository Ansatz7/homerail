import { FAILURE_PORT_NAMES } from "./graph.js";
import type { DAGEdge, DAGGraphData, ParsedDAG } from "./graph.js";

export type NodeState =
  | "PENDING"
  | "READY"
  | "RUNNING"
  | "WAITING_FOR_APPROVAL"
  | "WAITING_FOR_COMMAND"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED"
  | "SKIPPED";

export interface RoutedInput { fromNode: string; port: string; value: unknown; }

export interface DAGRun {
  runId: string;
  graph: DAGGraphData;
  loopSources: Set<string>;
  routedInputs?: Map<string, RoutedInput[]>;
  nodeStates: Map<string, NodeState>;
  handoffedNodes: Set<string>;
  afterSatisfied: Map<string, Set<string>>;
  inputSatisfied: Map<string, Set<string>>;
  mailboxes: Map<string, Map<string, unknown[]>>;
}

export const FAILURE_PORTS = FAILURE_PORT_NAMES;

export interface DAGTransitionResult {
  affectedNodes: string[];
  routedNodes: string[];
  terminalFailure?: boolean;
  terminalOutcome?: "success" | "failure" | "cancelled";
}

export interface DAGRoundResetInput {
  resetNodeIds: Iterable<string>;
  commandInputs?: ReadonlyMap<string, { port: string; value: unknown }>;
  carryoverInputs?: ReadonlyMap<string, ReadonlyArray<{
    fromNode: string;
    port: string;
    value: unknown;
  }>>;
}

export interface DAGRoundResetResult {
  resetNodes: string[];
  readyNodes: string[];
}

export function isFailurePort(port: string): boolean {
  return FAILURE_PORTS.has(port.toLowerCase());
}

export function edgeMatchesHandoff(edge: DAGEdge, port: string): boolean {
  if (edge.from_port !== port) return false;
  if (edge.condition === "always") return true;
  return isFailurePort(port)
    ? edge.condition === "on_failure"
    : edge.condition !== "on_failure";
}

function _incomingAfterDeps(edges: DAGEdge[], nodeId: string): DAGEdge[] {
  return edges.filter(
    (e) => e.to_node === nodeId && e.label === "after_dep",
  );
}

function _incomingExplicitEdges(edges: DAGEdge[], nodeId: string): DAGEdge[] {
  return edges.filter(
    (e) => e.to_node === nodeId && e.label !== "after_dep",
  );
}

function _incomingExplicitEdgesFrom(
  edges: DAGEdge[],
  nodeId: string,
  fromNode: string,
): DAGEdge[] {
  return _incomingExplicitEdges(edges, nodeId).filter(
    (e) => e.from_node === fromNode,
  );
}

function _initialState(graph: DAGGraphData, nodeId: string): NodeState {
  const deps = _incomingAfterDeps(graph.edges, nodeId);
  return deps.length === 0 ? "READY" : "PENDING";
}

export function createDAGRun(parsedDAG: ParsedDAG, runId: string): DAGRun {
  const nodeStates = new Map<string, NodeState>();
  const afterSatisfied = new Map<string, Set<string>>();
  const inputSatisfied = new Map<string, Set<string>>();
  const mailboxes = new Map<string, Map<string, unknown[]>>();

  for (const node of parsedDAG.graph.nodes) {
    nodeStates.set(node.node_id, _initialState(parsedDAG.graph, node.node_id));
    afterSatisfied.set(node.node_id, new Set<string>());
    inputSatisfied.set(node.node_id, new Set<string>());
    mailboxes.set(node.node_id, new Map<string, unknown[]>());
  }

  return {
    runId,
    graph: parsedDAG.graph,
    loopSources: new Set(parsedDAG.loop_sources),
    routedInputs: new Map(),
    nodeStates,
    handoffedNodes: new Set<string>(),
    afterSatisfied,
    inputSatisfied,
    mailboxes,
  };
}

function _ensureMailbox(run: DAGRun, nodeId: string, port: string): unknown[] {
  const nodeBox = run.mailboxes.get(nodeId);
  if (!nodeBox) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  if (!nodeBox.has(port)) {
    nodeBox.set(port, []);
  }
  return nodeBox.get(port)!;
}

function _joinHasEnoughRoutedInputs(
  run: DAGRun,
  nodeId: string,
  deps: DAGEdge[],
): boolean | undefined {
  const node = run.graph.nodes.find((candidate) => candidate.node_id === nodeId);
  if (node?.node_type !== "join_gateway") return undefined;
  const routedInputs = run.inputSatisfied.get(nodeId) ?? new Set<string>();
  const routedDependencies = new Set(deps
    .filter((dep) => _incomingExplicitEdgesFrom(run.graph.edges, nodeId, dep.from_node).length > 0)
    .map((dep) => dep.from_node));
  const routed = Array.from(routedDependencies).filter((dependency) => routedInputs.has(dependency)).length;
  const mode = node.gateway_config?.mode ?? "all";
  if (mode === "all") {
    const satisfiedDependencies = run.afterSatisfied.get(nodeId);
    return routed >= routedDependencies.size
      && deps.every((dependency) => satisfiedDependencies?.has(dependency.from_node));
  }
  const settled = new Set<NodeState>(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);
  const allDependenciesSettled = deps.every((dependency) => settled.has(run.nodeStates.get(dependency.from_node)!));
  // An any/n-of-m join must still execute its failed port when the available
  // votes do not reach quorum. Waiting until every mutually exclusive source
  // settles avoids both premature failure and a deadlock on skipped sources.
  return allDependenciesSettled && routed > 0;
}

function _tryPromote(run: DAGRun, nodeId: string): void {
  if (run.nodeStates.get(nodeId) !== "PENDING") return;
  const deps = _incomingAfterDeps(run.graph.edges, nodeId);
  const joinReady = _joinHasEnoughRoutedInputs(run, nodeId, deps);
  if (joinReady !== undefined) {
    if (joinReady) run.nodeStates.set(nodeId, "READY");
    return;
  }
  const satisfiedDeps = run.afterSatisfied.get(nodeId);
  const satisfied = deps.every((e) => satisfiedDeps?.has(e.from_node));
  if (!satisfied) return;

  const routedInputs = run.inputSatisfied.get(nodeId);
  for (const dep of deps) {
    const explicitFromDep = _incomingExplicitEdgesFrom(
      run.graph.edges,
      nodeId,
      dep.from_node,
    );
    if (explicitFromDep.length > 0 && !routedInputs?.has(dep.from_node)) {
      return;
    }
  }

  run.nodeStates.set(nodeId, "READY");
}

function _skipUntakenSatisfiedBranches(run: DAGRun, nodeId: string): void {
  if (run.nodeStates.get(nodeId) !== "PENDING") return;
  const deps = _incomingAfterDeps(run.graph.edges, nodeId);
  const satisfiedDeps = run.afterSatisfied.get(nodeId);
  const allDepsSatisfied = deps.every((e) => satisfiedDeps?.has(e.from_node));
  if (!allDepsSatisfied) return;

  const routedInputs = run.inputSatisfied.get(nodeId);
  const awaitsFutureLoopPort = deps.some((dep) => {
    if (!run.loopSources.has(dep.from_node) || run.nodeStates.get(dep.from_node) !== "RUNNING") return false;
    const explicitFromDep = _incomingExplicitEdgesFrom(run.graph.edges, nodeId, dep.from_node);
    return explicitFromDep.length > 0 && !routedInputs?.has(dep.from_node);
  });
  if (awaitsFutureLoopPort) return;
  const hasUntakenRequiredInput = deps.some((dep) => {
    const explicitFromDep = _incomingExplicitEdgesFrom(
      run.graph.edges,
      nodeId,
      dep.from_node,
    );
    return explicitFromDep.length > 0 && !routedInputs?.has(dep.from_node);
  });
  if (hasUntakenRequiredInput) {
    run.nodeStates.set(nodeId, "SKIPPED");
    _skipDependentNodes(run, nodeId, true);
  }
}

function _satisfyAfterDeps(run: DAGRun, fromNode: string): Set<string> {
  const affected = new Set<string>();
  for (const edge of run.graph.edges) {
    if (edge.label !== "after_dep" || edge.from_node !== fromNode) continue;
    run.afterSatisfied.get(edge.to_node)?.add(fromNode);
    affected.add(edge.to_node);
  }
  return affected;
}

function _predecessors(run: DAGRun, nodeId: string): string[] {
  return Array.from(new Set(
    run.graph.edges
      .filter((edge) => edge.to_node === nodeId)
      .map((edge) => edge.from_node),
  ));
}

function _hasAlternativePath(run: DAGRun, nodeId: string, excludePred: string): boolean {
  for (const predId of _predecessors(run, nodeId)) {
    if (predId === excludePred) continue;
    const status = run.nodeStates.get(predId);
    if (
      status === "COMPLETED" ||
      status === "RUNNING" ||
      status === "WAITING_FOR_COMMAND" ||
      status === "PENDING" ||
      status === "READY"
    ) {
      return true;
    }
  }
  return false;
}

function _skipDependentNodes(run: DAGRun, unavailableNodeId: string, sourceWasSkipped = false): void {
  for (const edge of run.graph.edges) {
    if (edge.from_node !== unavailableNodeId) continue;
    if (!sourceWasSkipped && edge.condition !== "on_success") continue;
    if (!edge.to_node) continue;
    const state = run.nodeStates.get(edge.to_node);
    if (state !== "PENDING" && state !== "READY") continue;
    // An explicit on_failure/always route from the failed node is allowed to
    // wake the same target; a plain after dependency is not.
    if (!sourceWasSkipped) {
      const hasFailureRoute = run.graph.edges.some((candidate) =>
        candidate.from_node === unavailableNodeId &&
        candidate.to_node === edge.to_node &&
        candidate.label !== "after_dep" &&
        (candidate.condition === "on_failure" || candidate.condition === "always")
      );
      if (hasFailureRoute || run.inputSatisfied.get(edge.to_node)?.has(unavailableNodeId)) continue;
    }
    if (_hasAlternativePath(run, edge.to_node, unavailableNodeId)) continue;
    run.nodeStates.set(edge.to_node, "SKIPPED");
    _skipDependentNodes(run, edge.to_node, true);
  }
}

/**
 * Settle nodes that can no longer receive every dependency they require.
 *
 * A bounded loop can have more than one feedback source. While the loop is
 * active, an untaken source must remain pending because a later iteration may
 * still select it. Once the loop exits, however, every predecessor can be
 * settled while that source is still pending: skipped predecessors never emit
 * an after-dependency transition. Revisit those nodes after each transition so
 * a dormant feedback branch cannot keep an otherwise completed run active.
 */
export function reconcileSettledPendingNodes(run: DAGRun): Set<string> {
  const affected = new Set<string>();
  const settled = new Set<NodeState>(["COMPLETED", "FAILED", "CANCELLED", "SKIPPED"]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const [nodeId, state] of run.nodeStates) {
      if (state !== "PENDING") continue;
      const dependencies = _incomingAfterDeps(run.graph.edges, nodeId);
      if (dependencies.length === 0) continue;
      if (!dependencies.every((edge) => settled.has(run.nodeStates.get(edge.from_node)!))) continue;

      _tryPromote(run, nodeId);
      if (run.nodeStates.get(nodeId) === "READY") {
        affected.add(nodeId);
        changed = true;
        continue;
      }

      run.nodeStates.set(nodeId, "SKIPPED");
      affected.add(nodeId);
      changed = true;
    }
  }
  return affected;
}

export function resetSkippedSuccessDescendants(run: DAGRun, retriedNodeId: string): void {
  const pending = run.graph.edges
    .filter((edge) => edge.from_node === retriedNodeId && edge.condition === "on_success")
    .map((edge) => edge.to_node)
    .filter(Boolean);
  const visited = new Set<string>();
  while (pending.length > 0) {
    const nodeId = pending.pop()!;
    if (visited.has(nodeId)) continue;
    visited.add(nodeId);
    if (run.nodeStates.get(nodeId) !== "SKIPPED") continue;
    run.nodeStates.set(nodeId, "PENDING");
    run.handoffedNodes.delete(nodeId);
    run.inputSatisfied.set(nodeId, new Set<string>());
    run.mailboxes.set(nodeId, new Map<string, unknown[]>());
    run.routedInputs?.set(nodeId, []);
    for (const edge of run.graph.edges) {
      if (edge.from_node === nodeId && edge.to_node) pending.push(edge.to_node);
    }
  }
}

export function reconcileFailedDependencies(run: DAGRun): string[] {
  const before = new Map(run.nodeStates);
  for (const [nodeId, state] of before) {
    if (state === "FAILED") _skipDependentNodes(run, nodeId);
  }
  return Array.from(run.nodeStates.entries())
    .filter(([nodeId, state]) => state === "SKIPPED" && before.get(nodeId) !== "SKIPPED")
    .map(([nodeId]) => nodeId)
    .sort();
}

function _wakeLoopSource(run: DAGRun, nodeId: string): void {
  if (!run.loopSources.has(nodeId)) return;
  if (run.nodeStates.get(nodeId) !== "RUNNING") return;
  const mailbox = run.mailboxes.get(nodeId);
  if (!mailbox) return;
  const hasData = Array.from(mailbox.values()).some((v) => v.length > 0);
  if (hasData) {
    for (const [port, values] of mailbox.entries()) {
      if (values.length > 1) {
        mailbox.set(port, [values[values.length - 1]]);
      }
    }
    run.handoffedNodes.delete(nodeId);
    run.nodeStates.set(nodeId, "READY");
  }
}

function _isLoopGateway(run: DAGRun, nodeId: string): boolean {
  const nodeType = run.graph.nodes.find((node) => node.node_id === nodeId)?.node_type;
  return nodeType === "loop_gateway" || nodeType === "while_gateway";
}

/** Reset the whole affected region before routing the new loop output. External
 * predecessors have already run and cannot resend their immutable inputs. Keep
 * those deliveries, including completion-only dependencies; discard old body
 * deliveries even when they share a destination port with external inputs. */
function _resetLoopBodyDescendants(run: DAGRun, loopNodeId: string, entries: string[]): void {
  const pending = [...entries];
  const reset = new Set<string>();
  while (pending.length) {
    const nodeId = pending.pop()!;
    if (nodeId === loopNodeId || reset.has(nodeId)) continue;
    reset.add(nodeId);
    for (const edge of run.graph.edges) {
      if (edge.from_node === nodeId && edge.to_node) pending.push(edge.to_node);
    }
  }
  const external = (source: string) => source !== loopNodeId && !reset.has(source);
  // Precompute before changing state: legacy snapshots with ambiguous merged
  // ports must fail explicitly rather than replaying stale feedback as a seed.
  const retained = new Map<string, RoutedInput[]>();
  for (const nodeId of reset) {
    let deliveries = run.routedInputs?.get(nodeId);
    if (!deliveries) {
      deliveries = [];
      for (const [port, values] of run.mailboxes.get(nodeId) ?? []) {
        const sources = [...new Set(_incomingExplicitEdges(run.graph.edges, nodeId)
          .filter(edge => edge.to_port === port && run.inputSatisfied.get(nodeId)?.has(edge.from_node))
          .map(edge => edge.from_node))];
        if (sources.some(external) && sources.some(source => !external(source))) {
          throw new Error(`DAG_LOOP_INPUT_PROVENANCE_MISSING ${nodeId}.${port}: legacy mixed-source input cannot be safely reset`);
        }
        if (sources.length && sources.every(external)) {
          for (const value of values) deliveries.push({ fromNode: sources[0], port, value });
        }
      }
    }
    retained.set(nodeId, deliveries.filter(input => external(input.fromNode)));
  }
  run.routedInputs ??= new Map();
  for (const nodeId of reset) {
    run.nodeStates.set(nodeId, "PENDING");
    run.handoffedNodes.delete(nodeId);
    run.afterSatisfied.set(nodeId, new Set([...run.afterSatisfied.get(nodeId) ?? []].filter(external)));
    run.inputSatisfied.set(nodeId, new Set([...run.inputSatisfied.get(nodeId) ?? []].filter(external)));
    const inputs = retained.get(nodeId)!;
    run.routedInputs.set(nodeId, inputs);
    const mailbox = new Map<string, unknown[]>();
    for (const input of inputs) {
      const values = mailbox.get(input.port) ?? [];
      values.push(input.value);
      mailbox.set(input.port, values);
    }
    run.mailboxes.set(nodeId, mailbox);
  }
}

export function recordInputDelivery(run: DAGRun, nodeId: string, fromNode: string, port: string, value: unknown): void {
  run.routedInputs ??= new Map();
  // A pre-provenance snapshot may already contain deliveries. Do not label
  // that node as fully tracked after recording only its first new delivery.
  if (!run.routedInputs.has(nodeId) && [...run.mailboxes.get(nodeId)?.values() ?? []].some(values => values.length)) return;
  const inputs = run.routedInputs.get(nodeId) ?? [];
  inputs.push({ fromNode, port, value });
  run.routedInputs.set(nodeId, inputs);
}

export function handoff(
  run: DAGRun,
  fromNode: string,
  port: string,
  content: unknown,
): DAGTransitionResult {
  if (!run.nodeStates.has(fromNode)) {
    throw new Error(`Unknown node: ${fromNode}`);
  }

  const matchingDownstream = run.graph.edges.filter(
    (edge) =>
      edge.from_node === fromNode &&
      edge.label !== "after_dep" &&
      edge.to_node !== "" &&
      edgeMatchesHandoff(edge, port),
  );
  const matchingTerminal = run.graph.edges.find(
    (edge) => edge.from_node === fromNode && edge.to_node === "" && edgeMatchesHandoff(edge, port),
  );
  const terminalOutcome = matchingTerminal?.terminal_outcome;
  const terminalFailure = terminalOutcome === "failure" ||
    (terminalOutcome === undefined && isFailurePort(port) && matchingDownstream.length === 0);
  const terminalCancelled = terminalOutcome === "cancelled";
  if (_isLoopGateway(run, fromNode)) {
    const entries = matchingDownstream.map(edge => edge.to_node);
    if (entries.some(nodeId => ["COMPLETED", "SKIPPED", "FAILED"].includes(run.nodeStates.get(nodeId)!))) {
      _resetLoopBodyDescendants(run, fromNode, entries);
    }
  }
  run.handoffedNodes.add(fromNode);
  run.nodeStates.set(
    fromNode,
    terminalFailure
      ? "FAILED"
      : terminalCancelled
        ? "CANCELLED"
      : run.loopSources.has(fromNode)
        ? "RUNNING"
        : "COMPLETED",
  );

  const affected = terminalFailure ? new Set<string>() : _satisfyAfterDeps(run, fromNode);
  const mailboxReceivers = new Set<string>();
  for (const edge of matchingDownstream) {
    recordInputDelivery(run, edge.to_node, fromNode, edge.to_port, content);
    _ensureMailbox(run, edge.to_node, edge.to_port).push(content);
    run.inputSatisfied.get(edge.to_node)?.add(fromNode);
    affected.add(edge.to_node);
    mailboxReceivers.add(edge.to_node);
  }

  for (const nodeId of affected) {
    _tryPromote(run, nodeId);
    _skipUntakenSatisfiedBranches(run, nodeId);
  }
  for (const nodeId of mailboxReceivers) {
    _wakeLoopSource(run, nodeId);

  }
  if (terminalFailure) {
    _skipDependentNodes(run, fromNode);
  }
  for (const nodeId of reconcileSettledPendingNodes(run)) affected.add(nodeId);
  return {
    affectedNodes: Array.from(affected).sort(),
    routedNodes: Array.from(mailboxReceivers).sort(),
    terminalFailure,
    terminalOutcome,
  };
}

export function failNode(
  run: DAGRun,
  nodeId: string,
  errorData: unknown = "",
): DAGTransitionResult {
  if (!run.nodeStates.has(nodeId)) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  run.nodeStates.set(nodeId, "FAILED");
  const affected = _satisfyAfterDeps(run, nodeId);
  const mailboxReceivers = new Set<string>();
  for (const edge of run.graph.edges) {
    if (edge.from_node !== nodeId) continue;
    if (edge.label === "after_dep" || edge.to_node === "") continue;
    if (edge.condition !== "on_failure" && edge.condition !== "always") continue;
    recordInputDelivery(run, edge.to_node, nodeId, edge.to_port, errorData);
    _ensureMailbox(run, edge.to_node, edge.to_port).push(errorData);
    run.inputSatisfied.get(edge.to_node)?.add(nodeId);
    affected.add(edge.to_node);
    mailboxReceivers.add(edge.to_node);
  }
  for (const affectedNode of affected) {
    _tryPromote(run, affectedNode);
    _skipUntakenSatisfiedBranches(run, affectedNode);
  }
  for (const receiver of mailboxReceivers) {
    _wakeLoopSource(run, receiver);
  }
  _skipDependentNodes(run, nodeId);
  for (const affectedNode of reconcileSettledPendingNodes(run)) affected.add(affectedNode);
  return {
    affectedNodes: Array.from(affected).sort(),
    routedNodes: Array.from(mailboxReceivers).sort(),
  };
}

/** Only diagnose a closed, stalled loop. External command/approval waits and
 * asynchronous workers are legitimate progress sources and suppress this. */
export function stalledLoopDiagnostic(run: DAGRun): string | undefined {
  if (![...run.loopSources].some(id => run.nodeStates.get(id) === "RUNNING")) return undefined;
  for (const [id, state] of run.nodeStates) {
    if (["READY", "WAITING_FOR_APPROVAL", "WAITING_FOR_COMMAND"].includes(state)) return undefined;
    if (state === "RUNNING" && !run.loopSources.has(id)) return undefined;
  }
  const pending = [...run.nodeStates].filter(([, state]) => state === "PENDING");
  if (!pending.length) return undefined;
  return "DAG_LOOP_STALLED: no runnable body or external wait; " + pending.map(([id]) => {
    const missing = _incomingAfterDeps(run.graph.edges, id).filter(edge =>
      !run.afterSatisfied.get(id)?.has(edge.from_node) ||
      (_incomingExplicitEdgesFrom(run.graph.edges, id, edge.from_node).length > 0 && !run.inputSatisfied.get(id)?.has(edge.from_node))
    ).map(edge => `${edge.from_node}:${run.nodeStates.get(edge.from_node)}`);
    return `${id} waits for [${missing.join(", ")}]`;
  }).join("; ");
}

export function isRunTerminal(run: DAGRun): boolean {
  for (const [id, state] of run.nodeStates) {
    if (state === "READY") return false;
    if (state === "WAITING_FOR_COMMAND" || state === "WAITING_FOR_APPROVAL") return false;
    if (state === "FAILED") continue;
    if (state === "SKIPPED" || state === "CANCELLED") continue;
    if (run.loopSources.has(id) && state === "RUNNING") continue;
    if (state === "RUNNING" || state === "PENDING") return false;
    if (state !== "COMPLETED") return false;
  }
  return true;
}

/**
 * Re-opens a bounded subset of a completed DAG for a new command round.
 * Nodes outside the subset retain their latest result and satisfy structural
 * dependencies, but their payload is not replayed into the new round. This
 * keeps a round scoped to the explicitly selected logical actors.
 */
export function resetNodesForRound(
  run: DAGRun,
  input: DAGRoundResetInput,
): DAGRoundResetResult {
  const resetNodes = Array.from(new Set(input.resetNodeIds)).sort();
  if (resetNodes.length === 0) throw new Error("A DAG round must reset at least one node");
  for (const nodeId of resetNodes) {
    if (!run.nodeStates.has(nodeId)) throw new Error(`Unknown node: ${nodeId}`);
  }

  const reset = new Set(resetNodes);
  const previousStates = new Map(run.nodeStates);
  const previousHandoffs = new Set(run.handoffedNodes);

  for (const nodeId of resetNodes) {
    run.nodeStates.set(nodeId, "PENDING");
    run.handoffedNodes.delete(nodeId);
    run.afterSatisfied.set(nodeId, new Set<string>());
    run.inputSatisfied.set(nodeId, new Set<string>());
    run.mailboxes.set(nodeId, new Map<string, unknown[]>());
    run.routedInputs?.set(nodeId, []);
  }

  for (const nodeId of resetNodes) {
    const afterSatisfied = run.afterSatisfied.get(nodeId)!;
    const inputSatisfied = run.inputSatisfied.get(nodeId)!;
    for (const carryover of input.carryoverInputs?.get(nodeId) ?? []) {
      const mailbox = run.mailboxes.get(nodeId)!;
      const values = mailbox.get(carryover.port) ?? [];
      values.push(carryover.value);
      mailbox.set(carryover.port, values);
      inputSatisfied.add(carryover.fromNode);
      recordInputDelivery(run, nodeId, carryover.fromNode, carryover.port, carryover.value);
    }
    for (const dependency of _incomingAfterDeps(run.graph.edges, nodeId)) {
      if (reset.has(dependency.from_node)) continue;
      const previous = previousStates.get(dependency.from_node);
      const supplied = previousHandoffs.has(dependency.from_node)
        && previous !== "FAILED"
        && previous !== "CANCELLED"
        && previous !== "SKIPPED";
      if (!supplied) continue;
      afterSatisfied.add(dependency.from_node);
    }
    const command = input.commandInputs?.get(nodeId);
    if (command) run.mailboxes.get(nodeId)!.set(command.port, [command.value]);
  }

  for (const nodeId of resetNodes) _tryPromote(run, nodeId);
  return {
    resetNodes,
    readyNodes: resetNodes.filter((nodeId) => run.nodeStates.get(nodeId) === "READY"),
  };
}

export function getReadyNodes(run: DAGRun): string[] {
  const ready: string[] = [];
  for (const [id, state] of run.nodeStates) {
    if (state === "READY") ready.push(id);
  }
  return ready.sort();
}

export function getNodeState(run: DAGRun, nodeId: string): NodeState {
  const state = run.nodeStates.get(nodeId);
  if (state === undefined) {
    throw new Error(`Unknown node: ${nodeId}`);
  }
  return state;
}

export function startNode(run: DAGRun, nodeId: string): void {
  const state = getNodeState(run, nodeId);
  if (state !== "READY") {
    throw new Error(
      `Cannot start node ${nodeId}: expected READY, got ${state}`,
    );
  }
  run.nodeStates.set(nodeId, "RUNNING");
}
