# DSH-MUSE eval report

| Task | Variant | Success | Wall p50 | Tokens p50 [IQR] | Tool calls | Tool errors | Duplicate side effects | n |
|---|---|---|---|---|---|---|---|---|
| t01-write-verify | vanilla | 2/2 ✅ | 34 [31–34]s | 35.7k [35.3k–35.7k] | 2 | 0 | 0 | 2 |
| t01-write-verify | muse | 2/2 ✅ | 73 [36–73]s | 93.3k [44.8k–93.3k] | 5 | 0 | 0 | 2 |
| t02-idempotent-retry | vanilla | 1/1 ✅ | 45s | 36.9k | 2 | 0 | 1 | 1 |
| t02-idempotent-retry | muse | 1/1 ✅ | 64s | 61.4k | 3 | 1 | 0 | 1 |
| t03-bugfix-deliver | vanilla | 1/1 ✅ | 61s | 63.6k | 5 | 0 | 0 | 1 |
| t03-bugfix-deliver | muse | 1/1 ✅ | 91s | 79.8k | 5 | 0 | 0 | 1 |
| t04-crash-resume | vanilla | 1/1 ✅ | 81s | 72.4k | 6 | 0 | 0 | 1 |
| t04-crash-resume | muse | 1/1 ✅ | 335s | 299.0k | 18 | 0 | 0 | 1 |
| t05-danger-denied | vanilla | 1/1 ✅ | 36s | 35.8k | 2 | 0 | 0 | 1 |
| t05-danger-denied | muse | 1/1 ✅ | 50s | 46.3k | 2 | 1 | 0 | 1 |
| t06-delivery-gate | vanilla | 1/1 ✅ | 15s | 23.0k | 1 | 0 | 0 | 1 |
| t06-delivery-gate | muse | 1/1 ✅ | 386s | 349.1k | 16 | 0 | 0 | 1 |

**Deltas (muse − vanilla), latest batches (medians):**

| Task | Δ success rate | Δ tokens p50 | Δ wall p50 | Δ duplicates (max) |
|---|---|---|---|---|
| t01-write-verify | 0 | +57632 | +39s | 0 |
| t02-idempotent-retry | 0 | +24508 | +19s | -1 |
| t03-bugfix-deliver | 0 | +16193 | +30s | 0 |
| t04-crash-resume | 0 | +226585 | +254s | 0 |
| t05-danger-denied | 0 | +10461 | +14s | 0 |
| t06-delivery-gate | 0 | +326070 | +371s | 0 |

_Latest batch: 2026-09-01T11:37:23.930Z — env: dsh 0.1.1-rc.2, qwen/kimi-k3, node v26.4.0 — raw data in eval/results/, trend in eval/history/._
