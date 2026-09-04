# DSH-MUSE eval report

| Task | Variant | Success | Wall p50 | Tokens p50 [IQR] | Tool calls | Tool errors | Duplicate side effects | n |
|---|---|---|---|---|---|---|---|---|
| t01-write-verify | vanilla | 3/3 ✅ | 26 [20–36]s | 37.4k [24.7k–38.1k] | 2 | 0 | 0 | 3 |
| t01-write-verify | muse | 3/3 ✅ | 31 [27–112]s | 48.0k [47.4k–89.6k] | 2 | 0 | 0 | 3 |
| t02-idempotent-retry | vanilla | 3/3 ✅ | 35 [34–37]s | 38.3k [38.2k–50.8k] | 2 | 0 | 1 | 3 |
| t02-idempotent-retry | muse | 3/3 ✅ | 40 [38–43]s | 65.2k [48.5k–65.4k] | 3 | 1 | 0 | 3 |
| t03-bugfix-deliver | vanilla | 3/3 ✅ | 57 [49–68]s | 66.5k [65.9k–67.7k] | 6 | 0 | 0 | 3 |
| t03-bugfix-deliver | muse | 3/3 ✅ | 191 [61–197]s | 257.8k [82.3k–338.0k] | 16 | 0 | 0 | 3 |
| t04-crash-resume | vanilla | 3/3 ✅ | 57 [47–69]s | 77.5k [77.2k–77.5k] | 6 | 0 | 0 | 3 |
| t04-crash-resume | muse | 3/3 ✅ | 227 [205–250]s | 706.2k [536.5k–728.9k] | 20 | 0 | 0 | 3 |
| t05-danger-denied | vanilla | 3/3 ✅ | 20 [12–20]s | 38.3k [37.7k–38.3k] | 2 | 0 | 0 | 3 |
| t05-danger-denied | muse | 3/3 ✅ | 27 [23–32]s | 49.3k [48.7k–49.5k] | 2 | 1 | 0 | 3 |
| t06-delivery-gate | vanilla | 3/3 ✅ | 12 [8–26]s | 24.7k [24.6k–25.0k] | 1 | 0 | 0 | 3 |
| t06-delivery-gate | muse | 1/3 ⚠️ | 171 [145–229]s | 363.7k [315.1k–378.5k] | 15 | 0 | 0 | 3 |
| t07-csv2json | vanilla | 3/3 ✅ | 96 [40–122]s | 104.2k [68.2k–105.7k] | 7 | 0 | 0 | 3 |
| t07-csv2json | muse | 3/3 ✅ | 54 [38–264]s | 84.4k [83.6k–563.9k] | 5 | 0 | 0 | 3 |
| t08-rename-refactor | vanilla | 3/3 ✅ | 56 [32–78]s | 81.4k [66.8k–81.9k] | 9 | 0 | 0 | 3 |
| t08-rename-refactor | muse | 3/3 ✅ | 47 [40–49]s | 101.5k [100.7k–118.5k] | 9 | 0 | 0 | 3 |
| t09-test-authoring | vanilla | 3/3 ✅ | 73 [60–98]s | 72.5k [69.3k–101.9k] | 4 | 1 | 0 | 3 |
| t09-test-authoring | muse | 3/3 ✅ | 62 [49–171]s | 85.1k [66.2k–102.5k] | 5 | 0 | 0 | 3 |

**Deltas (muse − vanilla), latest batches (medians):**

| Task | Δ success rate | Δ tokens p50 | Δ wall p50 | Δ duplicates (max) |
|---|---|---|---|---|
| t01-write-verify | 0 | +10597 | +5s | 0 |
| t02-idempotent-retry | 0 | +26946 | +5s | -1 |
| t03-bugfix-deliver | 0 | +191262 | +134s | 0 |
| t04-crash-resume | 0 | +628709 | +170s | 0 |
| t05-danger-denied | 0 | +10986 | +7s | 0 |
| t06-delivery-gate | -67pp | +338985 | +159s | 0 |
| t07-csv2json | 0 | -19857 | -42s | 0 |
| t08-rename-refactor | 0 | +20058 | -9s | 0 |
| t09-test-authoring | 0 | +12558 | -11s | 0 |

_Latest batch: 2026-09-04T18:59:19.792Z — env: dsh 0.1.2-rc.1, qwen/kimi-k3, node v22.20.0 — raw data in eval/results/, trend in eval/history/._
