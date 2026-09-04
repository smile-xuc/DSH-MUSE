# Findings

- DSH executable: /opt/homebrew/bin/dsh, installed package @deepseek-ai/dsh.
- Recent upgrade backup: ~/.dsh/backups/upgrade-0.1.2-rc.1; profile files modified at 23:45.
- Web profile enables the nine MUSE plugins plus Bailian web search.
- Existing README documents browser module coupling to DSH 0.1.1-rc.x.
- First process/port inspection found no active DSH service.

## Root cause clarification
- Two installations exist: global npm DSH 0.1.1-rc.2 and desktop runtime DSH 0.1.2-rc.1.
- Global service on 3080 renders correctly, including historical conversation and Muse tab.
- Desktop runtime resides at ~/Library/Application Support/ai.deepseek.harness/runtime.
- Desktop shell.log shows launch of upgraded runtime and navigation to a bare localhost URL (no token).
- New runtime prints a token-bearing authenticated URL. GET / without authentication returns HTTP 401 and explicitly requests reopening the printed URL.
- Existing desktop shell is ai.deepseek.harness, /Applications/DeepSeek Harness.app, built Aug 29.
- Therefore old desktop navigation is incompatible with newly required process authentication. Preserve auth; fix launcher or restore compatible runtime.

## Native replacement and verification
- Original source unavailable after local workspace/home/temp/build-cache and packaging-history searches. User reiterated that their packaged Mac app remained broken.
- Added an AppKit/WKWebView launcher under desktop/, retaining ai.deepseek.harness identity, bundled Node, installed DSH runtime and ~/.dsh data.
- Reads the complete official startup URL; no authentication bypass or static token.
- Original complete App backup: ~/.dsh/backups/mac-app-auth-20260905-001034/DeepSeek Harness.app.
- Original automatic runtime updater is not included; existing runtime remains at 0.1.2-rc.1. This limitation is documented and was communicated.
- Independent review findings addressed: serialize child teardown on retry/quit; make readiness probe non-destructive; support target=_blank links.
- Strict quit testing caught a real main-queue/AppKit nested termination-loop deadlock. Instrumentation showed child exit completed but main completion never ran. Reviewer reproduced independently; scheduling completion through the main run loop (including modal modes) fixed it. Fresh strict native smoke passed.

## Historical sessions disappear on selection — 2026-09-05
- Reproduced on desktop DSH 0.1.2-rc.1 in a browser as well as the user's Mac report; launcher was not deleting files.
- Exact backend error: `forwarded host event "api-session/added" argument 0 is not lossless JSON data`.
- `dsh-muse-bridge` generated `effects[].note: undefined` after successful shell calls. Other optional summary/legacy timestamps/step notes had the same issue. Agent activation rolled back and `session/disposed` emitted `api-session/removed`; client removed the sidebar entry.
- Fixed these constructors to use null; projection stateVersion 2 rebuilds derived caches. Plugin version 0.1.3. No DSH core modifications.
- Backed up all sessions/storages at `~/.dsh/backups/session-recovery-20260905-001846`; original installed plugin at `~/.dsh/backups/muse-history-20260905-002940`.
- 74 sessions and 527,168 events read/replayed successfully with the installed runtime's strict isJsonValue validator. SHA256 comparison: zero missing and zero changed logs.
