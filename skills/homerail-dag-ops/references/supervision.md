# Subscribe, await, and consume events

The current agent consumes DAG events using its existing tools. The skill does
not select a supervisor model, start another agent, or require Codex, ChatGPT,
Claude, a particular SDK, or a specific session API. Pick the transport the host
actually supports, rather than assuming that a skill itself can wake a model.

## Choose a supported waiting path

- **Blocking tool/event result (default):** use the bundled `register` and `wait`
  commands in [listener.md](listener.md). `wait` is one ordinary process call;
  it remains silent until a meaningful event is available, then returns JSON.
  The host awaits the tool and continues the same agent with its result. Do not
  replace this with a model-driven loop of status calls or repeated short waits.
- **Native host event subscription:** use the host's existing event tool or an
  HTTP/SSE client against HomeRail's existing endpoints. Preserve run identity,
  filtering, event receipt and consumption acknowledgment. A raw SSE chat delta
  is not automatically an actionable decision.
- **Optional push:** a verified adapter consumes the standard JSON event and
  hands it to the host's own notification/continuation API. The adapter decides
  whether the host queues, steers, or starts a continuation. These are host
  capabilities, not guarantees made by the skill. See the generic adapter
  contract in [listener.md](listener.md).

The bundled helper runs on Linux with Python 3.10+. The default `register`/
`wait` path needs neither systemd nor a notification executable. A persistent
user service is an optional deployment mode for hosts that need it. An agent
without shell access may use a provided HTTP/SSE tool or an existing deployed
bridge; a text-only conversation cannot create a lasting connection by itself.

## Register and hand off waiting

1. Resolve the Manager origin, actual run ID and a stable caller-chosen
   `consumer_id` for this task. It need not be a harness thread ID. Store the
   private subscription spec and register once. Reuse the same spec/store if
   the response is lost; do not duplicate the DAG.
2. Invoke the blocking `wait` tool, or verify the continuing observer and push
   destination if using an adapter. Registration alone is not an active listener.
3. Let the host wait without model inference. End the model turn only when a
   verified persistent subscription/callback path will resume the agent. Do not
   add periodic model automation, a goal loop, or a second agent executor.

## Consume an event

1. Read the single returned JSON event. Verify its consumer/subscription, run
   identity and digest. If already acknowledged, do not repeat side effects.
   For an optional callback, read the persisted event if needed to reconcile.
2. Read current run metadata once. Compare run ID, creation time, workflow
   revision/hash and creation request digest where available with the pinned
   identity. Metadata and approvals are separate reads; recheck a proposal's
   status/hash before presenting a decision, and ignore stale requests.
3. Handle the current reason:
   - `terminal`: verify artifacts/handoffs against task acceptance criteria.
   - `approval_required`: present the proposal and hash to the authorized human.
   - `command_required`: continue only within the user's authorization; otherwise
     ask for the missing decision. Persist action intent and reconcile ambiguous
     mutation results before retrying.
   - `quiet_timeout` / `observation_unavailable`: make one bounded diagnosis;
     these indicate an observation problem, not a failed DAG.
   - `identity_mismatch` / `observation_deadline` / `event_limit`: observation
     stopped. Explain the reason and reconcile without silently rerunning work.
4. Record the finding and any decision/action intent, then acknowledge using
   `ack <subscription> <event> <digest>` or the event's `ack_argv`. ACK means
   consumed, not approved or successfully completed. It may follow presentation
   of a decision request without waiting for the human's eventual answer.
5. If work is still pending, await the next event using the same host mechanism.
   A foreground `wait` exits after one event; call it again after consumption
   when continuing supervision. A persistent observer continues through approval
   ACKs and exits at a terminal outcome. Do not wake on unchanged progress.

## Older registrations

Existing version-1 subscriptions used a harness-specific notification contract.
Use their frozen absolute script paths to inspect/acknowledge/stop them; do not
reinterpret their command arguments with the new helper. New registrations use
version 2. If migrating active observation, reconcile its receipts and stop the
owned old observer before registering a replacement. Do not change the DAG or
silently start a second observer to work around a registration conflict.
