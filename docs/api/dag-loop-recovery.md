# Loop inputs and recovery

A loop starts each iteration with new body inputs while retaining deliveries
from predecessors outside the reset region. The reset includes completion-only
descendants, respects the loop boundary, and occurs once before routing all
selected output edges. It never makes a node ready without its dependencies.

Runtime snapshots record routed input provenance alongside mailboxes so an
external seed and an old feedback value sharing a port can be distinguished
across Manager restarts. This uses an optional JSON field, with no SQLite schema
migration. Legacy snapshots without provenance retain unambiguous external ports.
An ambiguous legacy port containing both external and loop-body deliveries fails
with `DAG_LOOP_INPUT_PROVENANCE_MISSING` rather than replaying stale feedback.

A running loop with pending nodes, no runnable body and no asynchronous worker,
command or approval wait fails with `DAG_LOOP_STALLED`. Its persisted abort reason
lists pending nodes and their unsatisfied predecessors. Legitimate command and
approval waits suppress this diagnostic. Existing cancelled runs remain terminal;
these changes do not restart or repair their history.
