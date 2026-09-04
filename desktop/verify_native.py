"""Smoke-test the actual native WebKit window, preserving DSH authentication."""
import pathlib
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

bundle = pathlib.Path(sys.argv[1]).resolve()
snapshot = pathlib.Path(sys.argv[2]).resolve()
log = pathlib.Path.home() / 'Library/Application Support/ai.deepseek.harness/native-launcher.log'
offset = log.stat().st_size if log.exists() else 0
snapshot.unlink(missing_ok=True)
history_args = []
if '--smoke-history-title' in sys.argv:
    index = sys.argv.index('--smoke-history-title')
    history_args = ['--smoke-history-title', sys.argv[index + 1]]
process = subprocess.Popen(
    [str(bundle / 'Contents/MacOS/deepseek-harness'), '--smoke-snapshot', str(snapshot), *history_args],
    start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
)
leave_running = '--leave-running' in sys.argv
success = False
try:
    deadline = time.monotonic() + 55
    while time.monotonic() < deadline:
        assert process.poll() is None, 'Native launcher exited before rendering'
        new = log.read_bytes()[offset:].decode('utf-8', errors='replace') if log.exists() else ''
        assert 'startup/navigation failure:' not in new, new
        assert 'native history smoke failed:' not in new, new
        if snapshot.exists() and 'native UI snapshot saved' in new:
            assert 'authenticated_url=true' in new, 'Launch token was dropped'
            assert 'main document HTTP 200' in new, 'Authenticated page did not return HTTP 200'
            assert 'native UI ready:' in new, 'No interactive DSH UI in native WebKit'
            if history_args:
                assert 'native history ready:' in new, 'Historical conversation did not remain open'
                print('PASS: historical session opens with its selected sidebar row and messages intact')
            port = int(re.search(r'navigation requested port=(\d+)', new).group(1))
            try:
                urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=5)
                raise AssertionError('Unauthenticated requests unexpectedly succeed')
            except urllib.error.HTTPError as error:
                assert error.code == 401, f'Unexpected unauthenticated status {error.code}'
            print('PASS: native WebKit renders authenticated DSH UI; bare requests remain HTTP 401')
            print(f'PASS: screenshot written to {snapshot}')
            success = True
            break
        time.sleep(0.25)
    assert success, 'Timed out waiting for native UI: ' + new
finally:
    if not (success and leave_running):
        process.terminate()
        try:
            process.wait(timeout=8)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
            raise AssertionError('Native launcher did not quit gracefully within 8 seconds')
        if log.exists():
            new = log.read_bytes()[offset:].decode('utf-8', errors='replace')
            match = re.search(r'runtime started pid=(\d+)', new)
            if match:
                try:
                    os.kill(int(match.group(1)), 0)
                except ProcessLookupError:
                    print('PASS: quitting native app stopped its runtime')
                else:
                    raise AssertionError('Runtime survived launcher termination')
