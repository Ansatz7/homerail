"""Opt-in Linux proof with real Manager routes/executor, no model or harness.

Default: register + blocking JSON wait, no service manager or notification CLI.
Add --service to test optional user-systemd recovery and a generic stdin adapter.
Use --evidence /absolute/fresh/private/directory to retain all receipts.
"""
import argparse
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import dag_subscription as d


def eventually(check, timeout=35):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = check()
        if value: return value
        time.sleep(.2)  # Ordinary fixture driver; no model invocations.
    raise AssertionError('integration condition timed out')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--evidence', required=True)
    parser.add_argument('--service', action='store_true')
    args = parser.parse_args()
    root = d.private(Path(args.evidence))
    fixture = d.private(root / 'manager')
    if (fixture / 'ready.json').exists(): raise ValueError('use a fresh evidence directory')
    log = (root / 'manager.log').open('w')
    env = {key: os.environ[key] for key in ('HOME', 'PATH', 'LANG') if key in os.environ}
    manager = subprocess.Popen([shutil.which('node'), str(d.HERE / 'manager_fixture.mjs'), str(fixture)],
                               env=env, stdout=log, stderr=log, start_new_session=True)
    registration, waiter = None, None
    try:
        def manager_ready():
            if manager.poll() is not None: raise AssertionError('fixture exited; inspect manager.log')
            return d.read(fixture / 'ready.json') if (fixture / 'ready.json').exists() else None
        ready = eventually(manager_ready)
        spec = {'version': 2, 'manager_url': ready['manager_url'], 'run_id': ready['run_id'],
                'consumer_id': 'integration-consumer', 'quiet_seconds': 60,
                'timeout_seconds': 110, 'request_seconds': 2}
        if args.service:
            code = 'import json,sys;from pathlib import Path;Path(sys.argv[1]).write_text(json.dumps(json.load(sys.stdin)))'
            spec['notify_argv'] = [sys.executable, '-c', code, str(root / 'adapter-event.json')]
        store = root / 'observer'
        cli = [sys.executable, str(d.HERE / 'dag_subscription.py'), '--home', str(store)]
        registration = json.loads(subprocess.check_output(cli + ['install' if args.service else 'register'],
                                                         input=json.dumps(spec).encode()))
        job = Path(registration['directory']); record = d.load_record(job)
        def start_waiter():
            return subprocess.Popen(cli + ['wait', record['id']], stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if not args.service:
            assert registration['service'] is None
            assert not d.load_state(job, record).get('observer'), 'registration must not launch an observer'
            waiter = start_waiter()
        def observer():
            value = d.load_state(job, record).get('observer', {})
            return value if value.get('process_identity') == d.process_identity(value.get('pid')) and value.get('pid') else None
        first = eventually(observer)
        eventually(lambda: d.load_state(job, record)['last_snapshot'])
        assert not d.load_state(job, record)['events'], 'ordinary progress must stay quiet'
        os.kill(first['pid'], signal.SIGKILL)
        if not args.service:
            assert waiter.communicate(timeout=5)[0] == b'', 'ordinary progress must not print output'
            waiter = start_waiter()  # Host can reissue a lost tool call with the same subscription.
        second = eventually(lambda: value if (value := observer()) and value != first else None)
        if args.service: assert d.systemctl('is-enabled', record['service']) == 'enabled'
        workspace = fixture / 'workspace' / ready['run_id']
        eventually(lambda: (workspace / 'count').exists())
        (workspace / 'release').touch()
        if args.service:
            def delivered():
                entries = d.load_state(job, record)['events']
                return entries if entries and all(e['delivery'] == 'accepted' for e in entries.values()) else None
            eventually(delivered)
            payload = d.read(root / 'adapter-event.json')
        else:
            output, error = waiter.communicate(timeout=35)
            assert waiter.returncode == 0, error
            assert len(output.splitlines()) == 1, output
            payload = json.loads(output)
            d.save(root / 'tool-event.json', payload)
        entries = d.load_state(job, record)['events']
        assert len(entries) == 1, entries
        entry = next(iter(entries.values()))
        assert payload['event'] == entry['event'] and payload['event_digest'] == entry['event_digest']
        assert entry['event']['kind'] == 'terminal' and entry['event']['details']['status'] == 'completed'
        assert (workspace / 'count').read_text() == 'x', 'DAG command must execute once'
        assert d.fetch_snapshot(spec)['status'] == 'completed'
        ack = json.loads(subprocess.check_output(payload['ack_argv']))
        assert ack['consumer'] == spec['consumer_id']
        proof = {'passed': True, 'real_manager_routes_and_executor': True, 'model_or_harness_calls': 0,
                 'mode': 'systemd-generic-adapter' if args.service else 'blocking-json-tool',
                 'service_restarted_after_sigkill': args.service, 'tool_reissued_after_sigkill': not args.service,
                 'observer_before': first, 'observer_after': second, 'ordinary_progress_notifications': 0,
                 'terminal_events': 1, 'dag_command_executions': 1, 'consumer_ack_verified': True,
                 'host_reboot_tested': False, 'registration': registration,
                 'event_id': entry['event']['event_id'], 'event_digest': entry['event_digest']}
        d.save(root / 'proof.json', proof)
        print(json.dumps(proof))
    finally:
        workspace = fixture / 'workspace' / 'skill-listener-proof'
        if workspace.is_dir(): (workspace / 'release').touch()
        if registration: d.unsubscribe(Path(registration['directory']))
        if waiter and waiter.poll() is None:
            waiter.terminate(); waiter.communicate(timeout=5)
        try: os.killpg(manager.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: manager.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(manager.pid, signal.SIGKILL); manager.wait()
        log.close()


if __name__ == '__main__': main()
