# Delivering instructions to an active DAG actor

Legacy `hr inject` and `POST /api/runs/:id/inject` cannot prove delivery. They
return `DAG_LEGACY_INJECT_UNSUPPORTED`, `delivered: false`, HTTP 409 and CLI exit
code 1. `--json` preserves the structured response. No instruction is sent on
this path, including the old interrupt and redispatch modes.

Use the tracked API with the Manager's existing `x-homerail-dag-token` credential.
Keep that token in private client configuration, outside prompts and receipts.

1. `GET /api/runs/:id/actors` returns the current actor IDs, round and state tokens.
2. Submit `POST /api/runs/:id/commands` with the round and actor token just read:

```json
{
  "expected_round_id": "<current round>",
  "commands": [{
    "actor_id": "<actual actor ID>",
    "expected_state_token": "<actor state_token, 64 hex characters>",
    "idempotency_key": "<unique intent ID, reuse on retry>",
    "payload": {"instruction": "<bounded follow-up instruction>"}
  }]
}
```

3. Read `GET /api/runs/:id/commands` for the persisted command receipt. A queued
   command is accepted, not consumed. Applied means the runtime consumed it;
   completed means the corresponding turn completed. Verify the actor's actual
   transcript/handoff to establish whether it addressed the instruction.

A stale state token or wrong round returns a conflict. Reinspect before making
any new intent. Retrying an uncertain submission must reuse its original
idempotency key and payload, not create another command. Disconnected workers
can leave durable commands queued; a socket write alone is never proof of
model delivery. Unsupported live steering returns an explicit failure.
