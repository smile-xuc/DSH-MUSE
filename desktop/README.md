# DeepSeek Harness macOS launcher

This small AppKit/WKWebView shell keeps the DSH app bundle, identity, icon, user data,
and Electron runtime. It reads the complete official `dsh web:` URL from the runtime
and lets DSH exchange its startup token for a signed cookie. It does not modify or
bypass DSH authentication. Tokens stay in memory and are never written to the launcher
log.

Current Electron bundles contain DSH at
`Contents/Resources/app/node_modules/@deepseek-ai/dsh`. The launcher starts that CLI
through the original Electron executable with `ELECTRON_RUN_AS_NODE=1` and
`--expose-internals`; `CFBundleExecutable` points to the native shell, and the original
Electron executable name is retained in `DSHElectronExecutable`. Older bundles remain
supported when they provide a standalone Node binary under
`Contents/Resources/resources/node/bin/node` and a DSH runtime under
`~/Library/Application Support/ai.deepseek.harness/runtime`.

The shell uses the existing `~/.dsh` settings, plugins, workspaces and sessions.
Close hides the window; clicking the Dock icon reopens it. Quit stops the child runtime.
The File menu can open the authenticated URL in a regular browser, and Cmd+R reloads or
retries.

The shell does not update the embedded DSH package. Build from a current DSH app bundle
to pick up its runtime version; the source app bundle is left unchanged during build.

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
Build products are ignored by git. The build starts from the installed bundle to reuse
the current DSH package, Electron runtime and icon; it does not install anything.

`install.py` first saves the complete original App to a timestamped folder under
`~/.dsh/backups/mac-app-auth-*`, then replaces only the executable and Info.plist,
and signs/verifies the installed bundle. It keeps the outer application directory
in place so Dock shortcuts continue to resolve it. The original Electron executable,
DSH package, runtime and user data remain in the bundle. A failed install restores the
backup.
