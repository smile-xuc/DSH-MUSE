# DeepSeek Harness macOS launcher recovery

The locally packaged Tauri app opened `http://127.0.0.1:<port>/` after startup.
DSH 0.1.2-rc.1 requires the launch token printed by `dsh web`, so that URL
returned HTTP 401. The original launcher source and build cache were unavailable.

This replacement is a small AppKit/WKWebView shell. It reads the complete official
`dsh web:` URL from its child process and lets DSH exchange the token for a signed
cookie. It does not modify or bypass DSH authentication. Tokens are kept in memory
and never written to the launcher log.

The bundle keeps the original application identity, icon and bundled Node.js.
It uses the existing runtime under
`~/Library/Application Support/ai.deepseek.harness/runtime`, and the existing
`~/.dsh` settings, plugins, workspaces and sessions. Close hides the window;
clicking the Dock icon reopens it. Quit stops the child runtime. The File menu
can open the authenticated URL in a regular browser, and Cmd+R reloads/retries.

The old shell's automatic npm runtime updater is not included. The installed
runtime is left at its existing version; manage future runtime upgrades explicitly.
This is a replacement native shell, not a recovered build of the original Tauri source.

## Build and verify

```sh
zsh build.sh
python3 verify_native.py 'build/DeepSeek Harness.app' build/native-smoke.png
python3 install.py
python3 verify_native.py '/Applications/DeepSeek Harness.app' build/installed-smoke.png --leave-running
# Also verify opening an existing conversation (no messages are sent):
python3 verify_native.py '/Applications/DeepSeek Harness.app' build/history-smoke.png --smoke-history-title 'existing conversation title'
```

The URL tests exercise token preservation, older tokenless output, LAN suffixes,
and rejection of unrelated or non-loopback URLs. The native smoke test runs the
real app, verifies HTTP 200 and an interactive page inside WKWebView, captures
the actual webview, and checks that unauthenticated requests still return 401.
The optional history check clicks the matching sidebar row, then requires the
selected row, session heading and a user message containing that title to remain
present for two seconds before taking the snapshot. Use a title derived from the
user's message (custom renamed titles may not match the transcript).
It runs only when both smoke-test flags are explicitly supplied.

Diagnostics: `~/Library/Application Support/ai.deepseek.harness/native-launcher.log`.
Build products are ignored by git. The build starts from the installed bundle
to reuse the already-installed Node.js and icon; it does not install anything.

`install.py` first saves the complete original App to a timestamped folder under
`~/.dsh/backups/mac-app-auth-*`, then replaces only the executable and Info.plist,
and signs/verifies the installed bundle. It keeps the outer application directory
in place so Dock shortcuts continue to resolve it. The original bundled Node,
runtime and user data are not replaced. A failed install restores the backup.
