# DAG skill acceptance

Branch: `codex/dag-event-subscriptions`. Runtime code baseline:
`ae61a9721388d3d23b9af6931b38e4580555000b`. Changes stay in skill directories;
do not merge or deploy HomeRail as part of skill validation.

## Current contract: model and harness independent

1. One skill covers design, execution, event waiting, decisions and evidence.
   It guides the current agent and never requires a second agent/model executor.
2. Version-2 registration requires only Manager/run/consumer identity and
   observation policy. The consumer ID is caller-owned and not tied to a
   harness session API. Repeating a registration is idempotent; incompatible
   specs or lifecycle modes are rejected.
3. `register` creates durable identity/state without starting an observer,
   systemd service or notifier. `wait` blocks in ordinary code, stays silent
   through routine progress, returns one actionable JSON event and exits.
   Reading the same unacknowledged event again is safe. It is not auto-ACKed.
4. Default waiting needs no model CLI, notification executable, systemd or
   platform-specific model configuration. Linux/Python requirements belong to
   the bundled helper, not to a particular agent harness. Other hosts can use
   the existing HTTP/SSE interfaces with their available tools.
5. An optional adapter receives exactly its configured argv and one JSON event
   on stdin. The helper adds no thread/message/queue/steer/model flags. Transport
   acceptance and consumption ACK remain distinct. Ambiguous deliveries never
   automatically resend; explicit redelivery preserves the stable event ID.
6. State is persisted before output/delivery. Lost tool results replay the same
   unacknowledged event. Reissued waits recover observation without resubmitting
   the DAG. Concurrent waiters reuse an existing observer; they may receive the
   same event, so consumers must deduplicate/ACK before repeating side effects.
7. Optional persistent user-systemd observation survives process failure using
   a frozen runtime and boot/process identity. Stopping observation leaves the
   DAG untouched and preserves receipts. A host callback or event continuation
   must be verified separately before claiming an agent can be woken.
8. Existing run metadata, approvals and SSE APIs are the only Manager inputs.
   Ordinary progress remains quiet; terminal/approval/command/quiet/outage events
   are distinct. Replayed raw SSE text is not persisted as model instructions.
   Observation failure never implies DAG success or failure.
9. The skill states that a model prompt cannot force suspension, steering or
   wakeup. A host without event/tool continuation cannot gain it by loading a
   skill. No exactly-once transport or lossless transient-event claim is made.
10. Legacy version-1 receipts remain readable/acknowledgeable using their frozen
    helpers. The new helper rejects registration/execution under the old command
    contract; migration must not silently duplicate an active observer or DAG.

## Reproduce

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover \
  -s skills/homerail-dag-ops/scripts -p 'test_*.py' -v
```

For the optional integration fixture, first build the existing protocol, plugin
SDK and Manager packages with their respective `npm --prefix <package> run build`.
The fixture uses unchanged Manager HTTP handlers and GraphExecutor with a real
deterministic command, never production Manager/Workers or model calls.

```bash
# Default transport: blocking JSON tool result, no notification CLI or systemd
PYTHONDONTWRITEBYTECODE=1 python3 skills/homerail-dag-ops/scripts/check_integration.py \
  --evidence /absolute/fresh/private/blocking-proof

# Optional systemd and generic stdin adapter, using a separate fresh directory
PYTHONDONTWRITEBYTECODE=1 python3 skills/homerail-dag-ops/scripts/check_integration.py \
  --service --evidence /absolute/fresh/private/service-proof
```

The default test registers in one process, interrupts/reissues the blocking wait,
asserts zero progress output and one command execution/event, then ACKs it. The
service test kills/restarts only its observer and records the standard JSON with
an ordinary stdin adapter. Both preserve evidence and stop their test observers.
Neither claims whole-host reboot or automatic host-session wakeup validation.

## Validation history and evidence scope

- Initial version-1 implementation: 15 tests, real Manager/systemd integration,
  and one real Codex queue callback/ACK passed. Idle-session wakeup was not
  tested. Full repository CI passed on rerun, after an intermittent existing
  finished-unconsumed recovery test failure; that failure was not claimed fixed.
- Skill consolidation: 15 helper tests, 59 Manager skill/schema/bootstrap tests,
  5 showcase-contract tests, reference checks and a relocated systemd fixture
  passed. These results precede the generic version-2 transport change.
- Generic version-2 transport: 20 helper tests and both fixture modes above
  passed on 2026-09-13, with zero model/harness calls in either fixture. Earlier
  Codex/full-CI results are historical and do not establish
  current adapter or host wakeup behavior. Store per-run proof outside the repo.
