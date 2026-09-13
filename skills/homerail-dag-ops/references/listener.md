# Generic event interface

Resolve `scripts/dag_subscription.py` relative to this skill, following its
installation symlink. The helper is an ordinary Linux Python 3.10+ program using
existing HomeRail GET/SSE APIs. It never invokes a model or a harness by default.
Its default private store is `${HOMERAIL_HOME:-~/.homerail}/dag-subscriptions`.
Use one consistent `--home` outside the project checkout if overriding it.

## Register and wait: no notification adapter required

Write a mode-0600 JSON spec in a private directory with verified values:

```json
{
  "version": 2,
  "manager_url": "http://MANAGER-IP:PORT",
  "run_id": "RETURNED_RUN_ID",
  "consumer_id": "my-project-task",
  "timeout_seconds": 86400,
  "quiet_seconds": 1800,
  "unavailable_seconds": 180,
  "request_seconds": 30
}
```

`consumer_id` is an opaque stable identity chosen by the caller. It is not a
required model name, harness type or platform thread ID.

```bash
python3 /absolute/skill/scripts/dag_subscription.py register < /private/spec.json
python3 /absolute/skill/scripts/dag_subscription.py wait SUBSCRIPTION_ID
```

`register` persists the run identity and freezes the helper outside the checkout;
its response does not claim that an observer is running. `wait` observes in its
own process unless another observer already holds the subscription lock. It
blocks without progress output, then returns **one JSON event** and exits. A
host with asynchronous tools should await the process through its tool runtime,
not repeatedly invoke the model to check it. Set the host tool's execution
lifetime to accommodate the intended wait; the subscription deadline does not
extend a host's shorter tool timeout.

The event output contains `version`, `consumer_id`, `subscription_id`, `event`,
`event_digest`, and `ack_argv` (an argument array for the frozen helper). The
nested event contains its stable ID, kind, pinned run identity and bounded
structured details. The same unacknowledged event can be returned again after
a lost tool response. Returning it is not an acknowledgment.

```bash
python3 /absolute/skill/scripts/dag_subscription.py event ID EVENT_ID
python3 /absolute/skill/scripts/dag_subscription.py ack ID EVENT_ID EVENT_DIGEST
```

After ACK, another `wait` observes the next actionable event. If observation
has stopped and there is no unacknowledged event, it returns `event: null` and
the stopped status. A cancelled tool can be resumed with the same subscription;
its persisted identity and event receipts remain. The helper cannot guarantee
host continuation after the host has closed its tool/session.

Optional `admin_token_file` references an absolute user-owned regular 0600 file
containing the existing Manager admin token. Token contents never enter the
subscription journal. Do not put credentials in the spec or command arguments.

## Optional notification adapter

Only configure an adapter when the host requires push and its receiving endpoint
is verified. Add an argument array to the spec:

```json
{
  "notify_argv": ["/absolute/path/to/host-adapter", "--destination", "my-task"]
}
```

These are additional fields in the full version-2 spec, not a separate spec.
The helper executes exactly that argv, passes one event JSON object plus newline
on **stdin**, and adds no model, thread, message, queue or steer flags. The JSON
is the same envelope returned by `wait`. No built-in host adapter is assumed.
Optional `environment` permits a `PATH` override only; the adapter manages its
own host configuration/credentials through the host's normal secure mechanism.

A zero adapter exit code means transport acceptance, not agent consumption.
Nonzero exit or timeout is ambiguous (`unknown`); a launch failure is
`not_started`. There is no automatic retry of accepted/unknown attempts. After
checking the receiving host, explicit redelivery preserves the event ID:

```bash
python3 /absolute/skill/scripts/dag_subscription.py redeliver ID EVENT_ID EVENT_DIGEST
```

The total budget is three attempts. The consumer must deduplicate by event ID
and ACK after processing. No generic adapter contract promises exactly-once
wakeup. With no adapter, event delivery is `available`; `wait`/`event` reads it.

## Optional persistent observer

A process supervisor may run the frozen helper's `run /absolute/subscription-dir`
command. On a Linux host already using user systemd with lingering enabled,
`install` is the optional register-and-enable-service operation:

```bash
python3 /absolute/skill/scripts/dag_subscription.py install < /private/spec.json
python3 /absolute/skill/scripts/dag_subscription.py status SUBSCRIPTION_ID
```

A service can use the optional adapter or leave events available for a blocking
`wait` consumer. Installing a service alone does not prove that the host can
wake an agent. Foreground/service mode is immutable per registration; do not
silently change an existing registration into a different lifecycle.

```bash
python3 /absolute/skill/scripts/dag_subscription.py unsubscribe ID
```

This marks observation stopped, stops/disables its owned service if any, and
preserves receipts. It does not cancel the DAG. An in-flight callback may still
arrive. A foreground observer notices cancellation at its next checkpoint.

## Observation and recovery contract

The same Manager origin, run ID and consumer ID under one store give one
subscription. Repeating an exact spec and mode is safe; incompatible changes
are rejected. Completed/stopped registrations remain stopped. Runtime hashes
and boot/process identities protect recovery from accidental checkout changes
and PID reuse. Corrupt state fails closed; keep evidence for diagnosis.

Existing endpoints are `GET /api/runs/:id`, `GET /api/dag/approvals` and
`GET /api/dag-status/:id/events`. The helper discards raw SSE payloads and reads
current metadata after relevant hints. Ordinary progress is coalesced; chat or
replayed history never directly becomes a decision. SSE has no durable cursor
or heartbeat, so socket timeouts/reconnects also reconcile state in ordinary
code. This is not a lossless journal of every transient condition.

Waiting approval suppresses a second command alert and quiet alerts. An unresolved
condition is reported once; an observed exit/re-entry can create a new event.
Outage/quiet alerts occur once per episode. Identity mismatch, observation
deadline and event limits stop observation. Bounded network/adapter calls and
reconnect backoff can delay deadline delivery. Observation errors never establish
DAG success/failure. The skill does not hard-stop or steer the current agent.
