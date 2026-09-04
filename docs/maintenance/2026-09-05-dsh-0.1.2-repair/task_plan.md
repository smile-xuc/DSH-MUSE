# DSH blank page recovery — 2026-09-04

## Goal
Restore the user's local DSH interface, diagnose the actual failure, and verify the result.

## Phases
- [x] Reproduce startup and identify the failing layer.
- [x] Restore browser access using the new runtime's official authenticated launch URL.
- [x] Verify browser rendering and preserve existing data/configuration.
- [x] Rebuild a compatible native launcher, back up the existing App, install and verify native rendering.
- [x] Diagnose historical sessions disappearing when opened; preserve session files before reproduction.
- [x] Fix the confirmed failure and verify history opening in the Mac app.

## History regression — 2026-09-05
All 74 session logs are still present. Full sessions/storages backup and SHA256 manifest saved at `/Users/bruce/.dsh/backups/session-recovery-20260905-001846`. Startup validation missed opening an old conversation. Investigate persistence/restore failure and the runtime's session/disposed → api-session/removed behavior before changing code.

Confirmed MUSE projection optional fields contained `undefined`; DSH 0.1.2 rejected api-session/added as non-lossless JSON, rolled back activation and emitted removal. Fixed five optional-field constructors and bumped projection stateVersion to 2. Regression tests, all-session replay, browser switching and actual native history opening pass. Original 74 log hashes are unchanged.

## Constraints
- Existing unrelated change: eval/guardrails-labeled.json. Preserve it.
- No DSH process was listening at the initial check.
- No DSH page is currently open in the available Chrome or in-app browser.

## Errors
- No app terminal is attached to this task; inspect startup directly.
- agent-browser browser executable is missing; used the available in-app browser for verification.
- Desktop runtime bare URL returns 401; browser reported ERR_BLOCKED_BY_CLIENT. This confirms missing startup authentication, not a frontend plugin crash.

## Outcome so far
The installed Mac app has been repaired with a compatible native launcher. Both fresh launch and quit/relaunch from /Applications passed: authenticated HTTP 200 and a real WKWebView conversation editor. Bare requests remain HTTP 401. Graceful quit also terminates the runtime. Final app is left running. Temporary browser-only recovery service was stopped.

## User follow-up
User confirmed the packaged Mac app still fails. Asked asynchronously for original source, but no local source/build cache exists. Proceed with a reversible native launcher replacement that retains the app identity, icon, bundled Node, installed DSH runtime and user data. The launcher must consume the official authenticated URL, show startup errors, support normal macOS window/menu operations, and avoid silently changing the installed runtime.
