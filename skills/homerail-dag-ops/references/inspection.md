# Inspect evidence and continue an existing run

Read only the evidence needed for the user's question or the received event.
Do not run every inspection command on every turn.

| Need | Existing command |
| --- | --- |
| Current state | `hr --json status <run_id>` or `hr dag quick <run_id> --events 10` |
| Work output | `hr dag handoffs <run_id> --content-limit 0` |
| Artifacts | `hr dag artifacts <run_id>` / `hr dag artifact <run_id> <name>` |
| A specific node's progress | `hr dag chats <run_id> --node <node-id> --tools 5` |
| Audit of tool use | `hr dag chats <run_id> --tools 20 --raw-tools` |
| Evaluation evidence | `hr scorecard <run_id>` / `hr eval-run <run_id>` |
| Recorded execution | `hr replay <run_id>` |

`replay` inspects recorded execution; it is not an instruction to rerun work.
If status is ambiguous, inspect a relevant node or handoff once. Use raw tools
only for a concrete audit question. Raw Worker audit files are a deep-debug
fallback at `${HOMERAIL_HOME}/audit/tool-events/<run_id>.jsonl`, with a legacy
global file on older installations. Prefer CLI/API reads over direct databases.

## Gateway results

Command, join, condition, loop, while, state and fanout nodes produce structured
results even without Worker chat logs. Use the existing authenticated
`GET /api/dag-status/<run_id>/node/<node_id>/result` against the configured
Manager. Inspect `result_kind`, `latest`, and relevant handoffs. No new endpoint
or custom UI is needed to read these results.

## Judge the work product

Compare terminal outcome, artifacts and handoffs with the agreed acceptance
criteria. Missing or auto-filled output is not success evidence. Check for:

- `WARN`/`FAIL` because a repository or input was inaccessible;
- a reviewer inspecting `/app` instead of the target repository;
- descriptions of what a node could not check presented as findings;
- missing evidence for a required hard gate.

Separate input, execution and work-product problems before proposing a fix.
A corrected input may justify a new authorized run, but not silent duplication.
Advisory scorecards do not automatically fail the task; strict policies and the
user's acceptance criteria define hard gates. Preserve concrete failure evidence
and the next actionable step.

## Continue the intended run

For an authorized correction to an executing actor, use tracked commands:

1. Read `GET /api/runs/:id/actors` for the actual actor ID, current round and
   opaque actor state token.
2. Submit `POST /api/runs/:id/commands` with `expected_round_id` and a `commands`
   entry containing `actor_id`, `expected_state_token`, `idempotency_key` and
   the workflow's typed `payload` (for instruction-based actors,
   `{"instruction":"<authorized correction>"}`). Use the existing private
   `x-homerail-dag-token` configuration. The Manager tool
   `send_dag_actor_command` provides the same tracked operation when available.
3. Read `GET /api/runs/:id/commands` for the receipt. Queued is not consumed;
   verify applied/completed state and the actor's transcript/handoff. Reuse the
   same idempotency key and payload after an uncertain submission; reread actor
   state on a conflict before deciding a new intent.

Legacy `hr inject` is unsupported: HTTP 409, `delivered:false`, CLI exit 1.
It sends no correction. Do not retry it with another legacy mode.

For waiting multi-Actor rounds, read
[multi-actor-surfaces.md](multi-actor-surfaces.md) and use the actual Actor ids,
round/state tokens and idempotency keys. Preserve unaffected Actors. Reconcile
an action's receipt/current state before retrying an ambiguous result.

Approval nodes require the authorized human's decision and current proposal
hash. Observer ACK records notification consumption only. Stopping the listener
leaves the DAG untouched; stopping the DAG is a separate lifecycle action.
Unavailable observation does not prove that the DAG failed or completed.
