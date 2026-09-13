---
name: homerail-dag-ops
description: Design, start, supervise, inspect, and continue HomeRail DAG workflows from any agent with CLI or HTTP access. Use for project work delegated to a DAG, workflow patterns, existing-run results, approval/Actor follow-ups, live panels, and background event callbacks. Handles the full run lifecycle with event-driven waiting instead of repeated model polling.
---

# HomeRail DAG

Use one workflow: **define outputs → choose/validate a DAG → start once → wait
outside the model → handle decisions → verify evidence**. Running and supervising
are stages of the same task. Load only the reference needed for the current
stage; do not load every HomeRail skill before starting.

## Choose the next action

| Request or current state | Action |
| --- | --- |
| New project work | Use the start path below; reuse a workflow/profile. |
| New topology or a reusable pattern | Read [patterns.md](references/patterns.md); inspect the live schema/catalog. |
| Active run requiring event-driven waiting | Read [supervision.md](references/supervision.md); use the current host’s blocking event tool or a verified optional adapter. |
| `[homerail-dag-event ...]` callback, including the former supervision skill name | Follow event consumption in [supervision.md](references/supervision.md). |
| Requested status, results, or diagnosis | Read [inspection.md](references/inspection.md); inspect only relevant evidence. |
| Live Actor panels or a later per-Actor command | Read [multi-actor-surfaces.md](references/multi-actor-surfaces.md). |

The old `homerail-dag-patterns` entry remains for compatibility. Its content
lives in this skill's references; it is not a prerequisite skill to load.

## Start once

1. Establish the output, source revision/inputs, permitted changes, budget, and
   acceptance evidence. If unattended supervision is needed, confirm the host
   can await a tool/event or receive a callback before starting the run. If a run ID already exists, inspect that run first.
2. Resolve the existing CLI and Manager origin. Use `hr doctor` for readiness;
   use `hr runtime status` if diagnosis is needed. If `hr` is absent but
   `HOMERAIL_CLI_ENTRYPOINT` is set, use `node "$HOMERAIL_CLI_ENTRYPOINT"`.
   Do not rebuild or restart a ready installation for an ordinary DAG run.
   Use `homerail-install-ops` only for an actual installation/service task.
3. Use `hr --json templates list`, or inspect a known database workflow. Read
   its input contract. Resolve template files from the verified HomeRail source
   or Manager catalog; `assets/...` is not relative to an arbitrary project.
4. Give Workers reachable inputs. Container Workers do not automatically see
   host paths: supply a cloneable repository URL and pinned revision, or the
   workflow's supported workspace/input mechanism. Keep input identity shared
   across nodes and verify access from the executing environment.
5. For a new/changed workflow, inspect `hr dag schema`, validate with `hr --json
   dag validate <file>`, then sync. Bind database LLM settings through a runtime
   profile; keep provider/model credentials out of workflow YAML.

```bash
# Existing database workflow and runtime profile
hr run --workflow <workflow-id> --profile <profile-id> --prompt "<task and inputs>"

# Alternatively: a concrete template with its actual input contract
hr run <verified-template-path> --prompt "<task and inputs>"
```

Template-embedded profiles and database profiles differ: use `--workflow` for a
DB profile or the documented sync flow. Check local help for unfamiliar flags.
Record the returned run ID, workflow revision/hash, inputs and acceptance
criteria in a private receipt. If submission has an unknown outcome, reconcile
existing runs; do not blindly create a replacement.

In the Manager Agent, available tools such as `list_orchestrations`,
`create_and_run`, `invoke_run`, `get_run_status`, `get_dag_schema`, and
`validate_dag_workflow` are shortcuts for covered operations. Use structured CLI
output for the rest. Any agent may use these CLI/HTTP contracts; no particular
supervisor model, SDK or harness is required. Do not launch another agent or
model merely to subscribe to or consume events.

## Wait, decide, and finish

The default bundled path is `register` → `wait` → handle the returned event →
`ack`. Registration persists identity; `wait` blocks in ordinary code and returns
one actionable JSON event. Let the host await that tool instead of repeatedly
invoking the model. Registration alone does not start a background observer.

If the host provides native event subscriptions, use its equivalent mechanism.
An optional callback adapter can deliver the same JSON into a persistent host
session. End the model turn after registration only when that continuing event
path is verified. A plain skill cannot force a host to suspend, steer or resume
an agent. If the host lacks event/tool continuation, explain that limitation;
do not claim automatic wakeup or substitute a Codex executor.

Routine progress stays quiet. `hr dag watch`/`supervise` remain optional
foreground inspection tools, not a model polling loop. A requested snapshot
needs no new watcher.

On a callback, verify the single event and current run identity, handle the
current condition, record the finding/action intent, and acknowledge consumption.
An ACK does not approve a proposal or end a waiting DAG. Let the human decide
approval nodes. Reconcile ambiguous mutation outcomes before retrying.

Check terminal status and relevant artifacts/handoffs against the original
acceptance criteria. A completed pipeline or passing advisory scorecard alone
is not proof of useful output. See [inspection.md](references/inspection.md).
End the turn when nothing actionable remains.

Keep secrets in existing Manager configuration/encrypted storage, never in
prompts, templates, receipts or commits. Keep deployment and disruptive runtime
changes within the user's authorized scope. For HomeRail self-development read
[architecture.md](references/architecture.md); for skill changes read
[acceptance.md](references/acceptance.md).
