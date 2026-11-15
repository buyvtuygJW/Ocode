# Development cleanup inventory — 2026-11-13

Inventory only: nothing was deleted during this audit.

**Reference explanation:** `.opencode/opencode.jsonc:5–9` configures the Effect checkout; `packages/core/src/reference.ts:76–93` materializes it and schedules refreshes. Deleting the checkout alone can cause a fresh clone while this reference remains configured.

Scope: the known OpenCode scratch root and Effect reference checkout. Existing source projects, delivered patches/reports, the active DB and its WAL/SHM, and the retained November backup are outside the cleanup selection.

Sizes are logical file bytes, excluding junction targets; hard links may reduce actual reclaimed space. Nearby matching writer records identify a participating model, not necessarily the sole creator.

| Group | Purpose | GiB | Entries |
|---|---|---:|---:|
| A | OpenCode development scratch and downloaded build/test dependencies | 7.211 | 50 |
| B | Proxy/dashboard development scratch | 1.273 | 32 |
| C | Old scratch database and database-repair scripts | 0.433 | 7 |
| D | Transcriber/ASR downloads and dependency caches | 11.918 | 9 |
| E | Configured Effect reference checkout | 0.033 | 1 |
| F | Transcriber build directory: active adb process (retain for now) | 13.049 | 1 |
| G | Final-output folders and other projects: ownership/use needs review | 0.063 | 12 |
| H | Runtime/config directories (retain) | 0.000 | 2 |

**Currently in use:** PID 15248 runs `adb.exe` from group F; it is not an inactive cleanup candidate.

## A — OpenCode development scratch and downloaded build/test dependencies

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `C:\Users\o\AppData\Local\Temp\opencode\autorepo` | 226.99 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\build-run.log` | 0.03 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\build-run2.log` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\build-run3.log` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\build.mjs.debug-backup` | 0.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\bun-portable` | 109.94 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\bun-probe` | 109.94 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\bun-windows-x64.zip` | 52.20 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\council-isolated-prototype` | 6.07 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\council-modes-20261112` | 11.68 | Created and used by this Astra-led council/permission task, including Sol fixtures. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\council-validation-20261111` | 903.87 | Earlier validation artifacts retained and reused by this Astra-led task. 3 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\dayjump` | 2.36 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\decay-bypass-prototype` | 0.02 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\drtest` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\effect-http-20261110` | 148.39 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\guard-drill` | 0.62 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\lifetime-check` | 442.74 | Existing dependency cache reused by this task; creation attribution is separate. 3 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\lifetime-grace-final-validation` | 0.04 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\lifetime-grace-validation` | 0.03 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\lifetime-review-unit.txt` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\lifetime-review.txt` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\lifetime-source-tests.txt` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\oc-patch-check-20261101` | 1136.68 | Creator unverified; classified by contents/path, not assigned to Fable. 11 unreadable entries; size is a lower bound. |
| `C:\Users\o\AppData\Local\Temp\opencode\patch-report-20261110` | 726.92 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\patchtest` | 290.65 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\patchtest-b` | 223.27 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-bcOOX0` | 0.02 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-GzyiUI` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-iqpHIr` | 0.58 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-IrbKOk` | 0.57 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-K9CVD8` | 0.58 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-Mbdy6C` | 0.61 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-suImM0` | 0.59 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-UsKWxA` | 0.30 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-regenerate-WdJyhO` | 0.30 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\photon-patch-investigation-20261109` | 348.42 | Creator unverified; classified by contents/path, not assigned to Fable. 4 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\solid-audit-20261111` | 0.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\subagent-test` | 0.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\theme-audit-20261110` | 148.38 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\upstream-prod` | 141.51 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\upstream-prod.zip` | 84.16 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-build-validation` | 2040.91 | Existing dependency cache reused by this task; creation attribution is separate. 6306 junction/reparse entries excluded. 6 unreadable entries; size is a lower bound. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-build-validation-output` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-dbg-src` | 223.92 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-patch-check-Hr32X6` | 0.15 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-patch-check-wQF0UZ` | 0.15 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-patch-final-pKIlNz` | 0.16 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-photon-check-gtzRAI` | 0.17 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-photon-final-2O2Neq` | 0.16 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\v11-transient-check-T8WedK` | 0.17 | Creator unverified; classified by contents/path, not assigned to Fable. |

## B — Proxy/dashboard development scratch

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `C:\Users\o\AppData\Local\Temp\opencode\dashboard-artifact-fix-9GbMr0` | 55.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dashboard-launcher-check-RcGKIG` | 0.02 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dashboard-layout-pack-Wi5njW` | 55.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dashboard-route-fix-32azZF` | 55.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dashboard-route-fix-VlV2Ku` | 15.74 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\git-exe-rewrite-ZwT6pg` | 1.28 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\launcher-check-U7Qumg` | 0.02 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\launcher-reuse-check-CsVyLq` | 0.02 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\model-dashboard-render-check.html` | 0.13 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\model-layout-check.html` | 0.13 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\model-persistence-check.html` | 0.13 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\model-persistence-pack-Mm32c0` | 55.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\npx-local-cache-test-sXaiBm` | 0.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\patch-gate-test-NRrGzh` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\proxy-injection-syntax-check.mjs` | 9.10 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\proxy-local-trace-0OY4Iv` | 6.06 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\proxy-local-trace-7UGCXs` | 6.06 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\proxy-local-trace-ADSalS` | 6.06 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\proxy-local-trace-CF0rku` | 6.06 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\proxy-local-trace-pOzpjA` | 6.06 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\proxy-local-trace-y1xmMu` | 6.06 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxmerge` | 62.66 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-base-rebuild-aYoc4g` | 95.85 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-ci-rebuild-eSWYFV` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-ci-rebuild-w2bbM6` | 33.02 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-full-ci-fixed-TgGjyg` | 268.69 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-full-ci-mkJC4G` | 121.28 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-launch-fix-vAZNZn` | 95.85 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-model-build-YqQbjZ` | 60.46 | Creator unverified; classified by contents/path, not assigned to Fable. 1 junction/reparse entries excluded. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-oauth-baseline-output.txt` | 0.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-oauth-usage-validation` | 235.85 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-proxy-patch-check-v0151` | 47.10 | Creator unverified; classified by contents/path, not assigned to Fable. |

## C — Old scratch database and database-repair scripts

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `C:\Users\o\AppData\Local\Temp\opencode\dbcheck.ts` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dbcheck2.ts` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dbtimes.ts` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dbtimes2.ts` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\fixallowance.ts` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\fixallowance2.ts` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\opx.db` | 442.91 | Old scratch DB from 2026-11-01; repair scripts reference it. Not the active X:/extbins/opencode/opencode.db. |

## D — Transcriber/ASR downloads and dependency caches

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `C:\Users\o\AppData\Local\Temp\opencode\android-transcriber-tools` | 1797.64 | Creator unverified; classified by contents/path, not assigned to Fable. 24 unreadable entries; size is a lower bound. |
| `C:\Users\o\AppData\Local\Temp\opencode\hf-asr-cache` | 4500.36 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\hf-cache` | 74.62 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\hf-model-download-diagnostic` | 0.02 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\lan-transcriber-https-test-20261111` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\lan-transcriber-https-test-20261111-v2` | 0.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\qwen3-merges-68818b.txt` | 1.59 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\sherpa-aar-inspect` | 0.23 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\uv-cache` | 5829.40 | Creator unverified; classified by contents/path, not assigned to Fable. |

## E — Configured Effect reference checkout

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `X:\extbins\opencode\repos\github.com\Effect-TS\effect-smol` | 33.88 | Configured in finalsnap/.opencode/opencode.jsonc:5-9; OpenCode Reference.refresh materializes it. Git reflog records a 2026-09-20 clone, not a model identity. |

## F — Transcriber build directory: active adb process (retain for now)

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `C:\Users\o\AppData\Local\Temp\opencode\lan-transcriber-c-build` | 13362.63 | Creator unverified; classified by contents/path, not assigned to Fable. |

## G — Final-output folders and other projects: ownership/use needs review

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `C:\Users\o\AppData\Local\Temp\opencode\aiwdog-before-fix-2bd6325aadd9402c80b2af79a0a57e01` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\bods158-direct-publish-WTFvUK` | 45.22 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\chatgpt-proxy-diagnostic-20261101` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\dedupe-20261027` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\honorX7c_user0_debloat_test` | 0.03 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\output-compat-validation` | 0.02 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\PDFWidget.class` | 0.01 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-single-final-v016` | 3.91 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\pxpipe-v016-final-out` | 7.83 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\ttlock-android` | 7.89 | Creator unverified; classified by contents/path, not assigned to Fable. 10 unreadable entries; size is a lower bound. |
| `C:\Users\o\AppData\Local\Temp\opencode\TuitionBrochure.class` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\TuitionBrochure.java` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |

## H — Runtime/config directories (retain)

| Exact path | MiB | Provenance/use |
|---|---:|---|
| `C:\Users\o\AppData\Local\Temp\opencode\.opencode` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
| `C:\Users\o\AppData\Local\Temp\opencode\personalize-boot-locks` | 0.00 | Creator unverified; classified by contents/path, not assigned to Fable. |
