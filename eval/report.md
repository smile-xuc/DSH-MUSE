# DSH-MUSE eval report

| Task | Variant | Verified success | Wall time | Tokens (in+out) | Tool calls | Tool errors | Duplicate side effects |
|---|---|---|---|---|---|---|---|
| t01-write-verify | vanilla | ✅ | 91s | 36856 | 2 | 0 | 0 |
| t01-write-verify | muse | ✅ | 44s | 47230 | 2 | 0 | 0 |
| t02-idempotent-retry | vanilla | ✅ | 45s | 36851 | 2 | 0 | 1 |
| t02-idempotent-retry | muse | ✅ | 38s | 62758 | 3 | 1 | 0 |
| t03-bugfix-deliver | vanilla | ✅ | 61s | 63637 | 5 | 0 | 0 |
| t03-bugfix-deliver | muse | ✅ | 91s | 79830 | 5 | 0 | 0 |

**Deltas (muse − vanilla), latest runs:**

| Task | Δ success | Δ tokens | Δ wall | Δ duplicates |
|---|---|---|---|---|
| t01-write-verify | 0 | +10374 | -47s | 0 |
| t02-idempotent-retry | 0 | +25907 | -7s | -1 |
| t03-bugfix-deliver | 0 | +16193 | +30s | 0 |

_Latest batch: 2026-09-01T02:24:30.909Z — raw data in eval/results/, trend in eval/history/._
