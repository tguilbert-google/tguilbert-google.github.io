#!/usr/bin/env python3
"""Smoke test for the E2E audio latency page's automation API.

Launches headless Chrome over the DevTools protocol (pipe transport), loads
the page and calls `window.e2eAudio.run()` for a few scenarios. With
`--loopback=pulse`, it first creates a PulseAudio/PipeWire virtual loopback
(a null sink, plus a remapped copy of its monitor as the input) and measures
the real Chrome audio path through it.

Usage:
  smoke_test.py [--loopback=none|pulse] [--chrome=PATH] [--file] [--bursts=N]

Exits with status 1 if any check fails.
"""

import argparse
import functools
import http.server
import json
import os
import select
import shutil
import subprocess
import sys
import tempfile
import threading
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PAGE = 'latency_tester/index.html'
SINK = 'e2e_loopback'
SOURCE = 'e2e_loopback_in'
SELFTEST_RTL_MS = 142.354  # `SIM_DELAY_SECONDS` rounded to whole samples at 48 kHz.
RUN_TIMEOUT_S = 90


class Chrome:
    """Minimal CDP client over --remote-debugging-pipe."""

    def __init__(self, binary, extra_flags):
        self.profile = tempfile.mkdtemp(prefix='e2e-audio-smoke-')
        r1, w1 = os.pipe()  # Chrome reads commands from fd 3.
        r2, w2 = os.pipe()  # Chrome writes responses to fd 4.
        flags = ['--headless=new', '--remote-debugging-pipe', f'--user-data-dir={self.profile}',
                 '--no-first-run', '--no-default-browser-check', '--no-proxy-server',
                 '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream',
                 *extra_flags]
        self.proc = subprocess.Popen(
            [binary, *flags, 'about:blank'], pass_fds=(3, 4),
            preexec_fn=lambda: (os.dup2(r1, 3), os.dup2(w2, 4)),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.close(r1)
        os.close(w2)
        self.w = os.fdopen(w1, 'wb')
        self.r = r2
        self.buf = b''
        self.next_id = 0
        self.session = None

    def call(self, method, params=None, timeout=RUN_TIMEOUT_S):
        self.next_id += 1
        msg = {'id': self.next_id, 'method': method, 'params': params or {}}
        if self.session:
            msg['sessionId'] = self.session
        self.w.write(json.dumps(msg).encode() + b'\0')
        self.w.flush()
        deadline = time.time() + timeout
        while True:
            while b'\0' not in self.buf:
                remaining = deadline - time.time()
                if remaining <= 0 or not select.select([self.r], [], [], remaining)[0]:
                    raise TimeoutError(f'{method} timed out after {timeout} s')
                chunk = os.read(self.r, 1 << 16)
                if not chunk:
                    raise RuntimeError('Chrome closed the pipe')
                self.buf += chunk
            raw, self.buf = self.buf.split(b'\0', 1)
            resp = json.loads(raw)
            if resp.get('id') == self.next_id:
                if 'error' in resp:
                    raise RuntimeError(f"{method}: {resp['error']}")
                return resp.get('result', {})

    def open(self, url):
        target = self.call('Target.createTarget', {'url': 'about:blank'})['targetId']
        self.session = self.call('Target.attachToTarget', {'targetId': target, 'flatten': True})['sessionId']
        try:
            self.call('Page.navigate', {'url': url}, timeout=20)
        except TimeoutError:
            raise TimeoutError(f'Could not load {url}. If Chrome cannot reach localhost here, retry with --file.')
        deadline = time.time() + 20
        while time.time() < deadline:
            if self.eval('typeof window.e2eAudio === "object"'):
                return
            time.sleep(0.25)
        raise TimeoutError(f'window.e2eAudio did not appear at {url}')

    def eval(self, expression, await_promise=False):
        r = self.call('Runtime.evaluate', {'expression': expression, 'awaitPromise': await_promise,
                                           'returnByValue': True})
        if 'exceptionDetails' in r:
            raise RuntimeError(r['exceptionDetails'].get('exception', {}).get('description', r))
        return r['result'].get('value')

    def close(self):
        try:
            self.session = None
            self.call('Browser.close', timeout=10)
        except Exception:
            pass
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        shutil.rmtree(self.profile, ignore_errors=True)


class PulseLoopback:
    """A null sink, plus a remapped copy of its monitor as a regular source.

    Chrome doesn't list monitor sources as inputs, hence the remap.
    """

    def __init__(self):
        self.modules = []

    def __enter__(self):
        self._load('module-null-sink', f'sink_name={SINK}', f'sink_properties=device.description={SINK}')
        self._load('module-remap-source', f'master={SINK}.monitor', f'source_name={SOURCE}',
                   f'source_properties=device.description={SOURCE}')
        self._check_capture()
        return self

    def _check_capture(self):
        # Some servers (e.g. Chrome Remote Desktop's private PipeWire, which has
        # no session manager) accept the modules but can't link capture streams.
        time.sleep(0.5)
        rec = subprocess.Popen(['parec', '-d', SOURCE, '--raw', '--latency-msec=20'],
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        time.sleep(0.5)
        rec.terminate()
        out, err = rec.communicate()
        if not out:
            self.__exit__()
            server = os.environ.get('PULSE_SERVER') or os.environ.get('PULSE_RUNTIME_PATH') or 'default'
            sys.exit(f'Cannot capture from {SOURCE} on the Pulse server ({server}): {err.decode().strip()}\n'
                     'Point PULSE_SERVER or PULSE_RUNTIME_PATH at a full session server '
                     '(e.g. PULSE_RUNTIME_PATH=/run/user/$UID/pulse).')

    def _load(self, *args):
        out = subprocess.run(['pactl', 'load-module', *args], capture_output=True, text=True, check=True)
        self.modules.append(out.stdout.strip())

    def __exit__(self, *exc):
        while self.modules:
            subprocess.run(['pactl', 'unload-module', self.modules.pop()], capture_output=True)


def serve(directory):
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
    handler.log_message = lambda *a: None
    server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


class Checker:
    def __init__(self):
        self.failures = []

    def expect(self, cond, what):
        print(f"    [{'ok' if cond else 'FAIL'}] {what}")
        if not cond:
            self.failures.append(what)


def run_case(chrome, name, config):
    t0 = time.time()
    result = chrome.eval(f'window.e2eAudio.run({json.dumps(config)})', await_promise=True)
    m = result.get('metrics') or {}
    print(f"  {name}: status={result['status']} reason={result.get('reason')} ({time.time() - t0:.1f} s)")
    if m:
        print('    ' + ', '.join(f'{k}={v}' for k, v in m.items()))
    elif result.get('message'):
        print(f"    message: {result['message']}")
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--loopback', choices=['none', 'pulse'], default='none')
    ap.add_argument('--chrome', default=shutil.which('google-chrome-stable') or shutil.which('google-chrome'))
    ap.add_argument('--file', action='store_true',
                    help='Load the page from file:// instead of a local HTTP server.')
    ap.add_argument('--bursts', default='5', choices=['1', '5', '10', '20'])
    ap.add_argument('--page', default=PAGE,
                    help='Page path relative to the repo root, e.g. latency_tester/v4/index.html.')
    args = ap.parse_args()
    if not args.chrome:
        sys.exit('Chrome not found; pass --chrome.')

    flags = []
    if args.file:
        # Blob-URL worklets need these on file://.
        flags += ['--allow-file-access-from-files', '--disable-web-security']
        url = f'file://{REPO}/{args.page}'
        server = None
    else:
        server = serve(REPO)
        url = f'http://127.0.0.1:{server.server_address[1]}/{args.page}'
    if args.loopback == 'none':
        flags.append('--use-fake-device-for-media-stream')

    check = Checker()
    loop = PulseLoopback() if args.loopback == 'pulse' else None
    try:
        if loop:
            loop.__enter__()
        chrome = Chrome(args.chrome, flags)
        try:
            chrome.open(url)
            print(f"Page {chrome.eval('window.e2eAudio.pageVersion')}, schema {chrome.eval('window.e2eAudio.schemaVersion')}, {url}")
            bursts = args.bursts

            r = run_case(chrome, 'invalid config', {'bursts': '7'})
            check.expect(r['status'] == 'setup_error' and r['reason'] == 'invalid_config', 'invalid value is rejected')

            r = run_case(chrome, 'selftest', {'profile': 'selftest', 'bursts': bursts, 'quiet': True})
            m = r.get('metrics') or {}
            check.expect(r['status'] == 'ok', 'selftest status ok')
            check.expect(abs((m.get('rtl_ms') or 0) - SELFTEST_RTL_MS) < 0.05, f'selftest rtl_ms ~= {SELFTEST_RTL_MS}')
            check.expect(m.get('bursts_detected') == int(bursts), 'all selftest bursts detected')
            check.expect((r.get('preflight') or {}).get('verdict') == 'ok', 'selftest preflight ok')
            marks = chrome.eval(f"performance.getEntriesByType('measure').filter((e) => e.name.startsWith('e2e-audio:')).length")
            check.expect(marks == int(bursts) + 1, f'{int(bursts) + 1} User Timing measures (got {marks})')

            r = run_case(chrome, 'selftest + simulated glitch', {'profile': 'selftest', 'bursts': '5', 'simGlitch': True, 'preflight': False})
            check.expect(r['status'] == 'ok' and (r.get('metrics') or {}).get('glitch_count') == 1, 'glitch counted, not fatal')

            if loop:
                devices = {'input': f'^{SOURCE}$', 'output': f'^{SINK}$', 'quiet': True, 'bursts': bursts}
                r = run_case(chrome, 'no matching input', {**devices, 'input': 'no-such-device'})
                check.expect(r['status'] == 'setup_error' and r['reason'] == 'no_input_match', 'unmatched input is a setup_error')
                results = {}
                for name, cfg in [('webaudio-interactive', {'latencyHint': 'interactive'}),
                                  ('webaudio-playback', {'latencyHint': 'playback'}),
                                  ('media-element-stream', {'mode': 'audio_element_stream'})]:
                    r = run_case(chrome, name, {**devices, **cfg})
                    results[name] = r
                    m = r.get('metrics') or {}
                    check.expect(r['status'] == 'ok', f'{name} status ok')
                    check.expect(1 < (m.get('rtl_ms') or 0) < 500, f'{name} rtl_ms plausible')
                    check.expect(r['environment']['inputLabel'] == SOURCE and r['environment']['outputLabel'] == SINK,
                                 f'{name} used the loopback devices')
                a = (results['webaudio-interactive'].get('metrics') or {}).get('rtl_ms')
                b = (results['webaudio-playback'].get('metrics') or {}).get('rtl_ms')
                check.expect(a is not None and b is not None and b > a, 'playback latency > interactive latency')
        finally:
            chrome.close()
    finally:
        if loop:
            loop.__exit__(None, None, None)
        if server:
            server.shutdown()

    print('PASS' if not check.failures else f'FAIL: {len(check.failures)} check(s) failed')
    sys.exit(1 if check.failures else 0)


if __name__ == '__main__':
    main()
