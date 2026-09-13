/**
 * Legacy inject command — report rejection and point to tracked actor commands.
 */

import type { HomeRailClient } from "../client.js";

export async function cmdInject(
  client: HomeRailClient,
  runId: string,
  nodeId: string,
  instruction: string,
  mode: string,
  json = false,
): Promise<number> {
  const resp = await client.inject(runId, nodeId, instruction, mode);
  const data = resp.data as { delivered?: boolean; delivery_gap?: string } | undefined;
  const delivered = resp.success && data?.delivered === true;
  if (json) {
    console.log(JSON.stringify(resp, null, 2));
  } else if (!delivered) {
    console.error(`Instruction was not delivered: ${data?.delivery_gap ?? resp.message ?? "No delivery receipt"}`);
    console.error("Use GET /api/runs/:id/actors then POST /api/runs/:id/commands (x-homerail-dag-token; expected_round_id, expected_state_token, idempotency_key). See docs/api/dag-live-commands.md.");
  } else {
    console.log(`Delivered to ${nodeId} @ ${runId}`);
  }
  return delivered ? 0 : 1;
}
