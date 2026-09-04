# Progress

- Loaded using-superpowers, systematic-debugging, planning-with-files, and verification-before-completion instructions.
- Inspected repository, executable, profile package and patch file, process list, and browser inventory.
- Next: reproduce `dsh web` startup and collect its output.

- Confirmed two installations; global CLI 0.1.1-rc.2 was a working comparison, not the upgraded desktop runtime.
- Reproduced desktop 0.1.2-rc.1 authentication failure: bare URL returns HTTP 401.
- Opened the runtime's token-bearing startup URL; official token exchange redirects to the clean URL and the page renders.
- Verified newer runtime home, workspace, historical sessions, model selector, and Token statistics.
- Preserved application settings, credentials, session storage, and installed plugins.
- Could not find desktop launcher source under workspace, home, or local temporary directories. Existing application is a compiled Tauri shell. Do not remove its authentication or replace its implementation speculatively.
- Browser access restored; desktop source/download origin required for the remaining launcher fix.

## Native app recovery, after user follow-up
- Rebuilt a source-controlled AppKit/WKWebView launcher, preserving app identity/icon/bundled Node and the existing DSH runtime/data.
- URL regression tests first failed (missing token-preserving parser), then passed 10/10 after implementation.
- Native smoke test: real WKWebView returned HTTP 200, rendered 24 buttons and an editor, and produced a screenshot. Unauthenticated requests still returned HTTP 401.
- Visually inspected native-smoke.png: DSH homepage, model selector, input, workspace and historical sessions visible.
- Confirmed test launcher quit also stopped its Node runtime and released its port.
- Independent code review is in progress before installation.

- Independent review complete; corrected child lifecycle, non-destructive readiness checks and external-link handling.
- Tightened smoke test to fail if native app requires SIGKILL. It caught an AppKit termination-loop deadlock; reproduced and fixed using modal-aware RunLoop completion. Runtime shutdown and native app quit now both pass without forced termination.
- Corrected detached test-launch ownership so the app survives after the tool shell exits when left running.
- Original full App preserved at ~/.dsh/backups/mac-app-auth-20260905-001034/DeepSeek Harness.app; app replacement leaves bundle directory/Dock reference, bundled Node, runtime and user data intact.
- Installing final code and validating a fresh quit/relaunch from /Applications.

- Final installation and fresh quit/relaunch both passed from /Applications/DeepSeek Harness.app. Native document HTTP 200, 24 buttons + editor, visual snapshot available at desktop/build/installed-relaunch.png. Anonymous requests remain 401.
- Confirmed strict graceful exit succeeds, then launched final app detached and left it running independently of the test shell.
- Stopped the previous browser-only recovery runtime on port 3081. Original first backup remains mac-app-auth-20260905-001034; intermediate native version additionally backed up at mac-app-auth-20260905-001454.
- Task complete. No user credentials, runtime version, sessions, plugins or unrelated guardrails fixture change were modified by this repair.

## Follow-up: historical session opening
- Startup validation previously covered only the list/editor; opening older conversations was missed.
- Preserved all 74 logs and storages before reproducing; confirmed sessions disappear from UI after MUSE summary serialization rejects undefined fields.
- TDD: three representative replay tests failed on undefined fields before fix; all four tests pass afterward. Independent plugin review passed.
- Converted generated missing optional values to null and invalidated old derived caches via stateVersion 2; installed only the fixed MUSE bridge lib/package after backup.
- Read-only replay of all 74 logs / 527,168 events passed strict JSON validation. Browser opened Ubuntu and DSH-MUSE histories and switched back; zero activation errors.
- Added explicitly gated native history smoke verification. It requires the target sidebar row, session heading and target user message to remain present over two seconds. Independent review passed after strengthening this settled-state check.
- Built/installed native launcher, preserving app bundle identity/resources; verified history rendering inside real WKWebView. Snapshot: desktop/build/history-installed.png. App left open on the recovered Ubuntu conversation. No messages were sent.
- All original 74 session logs match the pre-reproduction SHA256 manifest exactly. Unrelated eval/guardrails-labeled.json change preserved.
