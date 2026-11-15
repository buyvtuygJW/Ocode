# Weekly-report audit — 2026-11-12

Target: `D:/Prog/own/mixed/lclagenticplatform/agenticproj_genV3/skillrepo/ps/genweeklyreport`.

Two fresh independent Terra reviewers and one Astra reviewer received the same brief without peer findings or parent history. A separate fresh Sol judge inspected the submissions and executed bounded offline production-script fixtures. No target files changed.

## Confirmed priorities

1. **Timezone loss/misdating — high, reproduced.** `gitea_activity.py:119,129–137` compares/displays raw UTC timestamp dates despite UTC+8 report bounds. `2026-11-01T17:00Z` belongs to Monday November 2 locally but is discarded, including by the issue-update prefilter. Parse aware timestamps, compare instants, and display UTC+8 dates.
2. **Stale XLSX template data — high, source-backed; runtime blocked.** `build_xlsx.py:36–60` copies the template without clearing unused task rows, link cells, hyperlinks, or old task-region merges. An unlinked new task can inherit an old proof link. Clear the defined data region while retaining formatting. The executable fixture was skipped because `openpyxl` is unavailable.
3. **Wrong Markdown issue label — medium, reproduced.** `build_md.py:20–31,45` generates a collision key such as `app-42-2`, then displays its final token as issue `#2` instead of `#42`. Derive the visible number from the original URL, independently of reference-key disambiguation.

## Qualified findings

- **Timeline pagination:** one request without page/limit is confirmed; mocked pagination loses a page-two action. Actual deployed endpoint pagination/version was not verified, so production data loss remains conditional.
- **Current versus historical issue state:** production output mixes current state/labels with date/type-only historical events, losing transition details. This is an attribution risk, not proof of automatically generated false completion.
- **Old closed issues:** absent from the script's candidate searches when not recently updated. The skill also requires manual old-issue checking; this is a workflow coverage gap rather than a standalone blocker.
- **Custom-period presentation:** weekday-only task labels can make multi-week output ambiguous and the heading omits the end date. The existing free-form day field accepts explicit dates, so ambiguity is avoidable without changing the schema.

No concrete DOCX defect was substantiated. Script-level email approval was not reported as a defect because the skill explicitly assigns it to the operator.

## Executed evidence

**17 tests: 15 passed, 2 skipped.** Passing defect assertions reproduce faulty behavior; they do not mean the production code is correct.

- Production Python modules were imported and executed.
- Only HTTP responses were mocked; network connection attempts were blocked.
- Existing security tests: six passed; the XLSX formula-safety test was skipped.
- Judge fixtures: nine passed; the XLSX stale-template fixture was skipped.
- No credentials, network services, email sending, installations, builds, or target modifications were used.

Runtime: `C:/Users/o/AppData/Roaming/uv/python/cpython-3.12.13-windows-x86_64-none/python.exe`.

Reproduce:

```powershell
& 'C:/Users/o/AppData/Roaming/uv/python/cpython-3.12.13-windows-x86_64-none/python.exe' -B 'C:/Users/o/AppData/Local/Temp/opencode/council-modes-20261112/weekly-judge/judge.py'
```

Full adjudication, fixture source, captured requests, generated Markdown, and exact test output:
`C:/Users/o/AppData/Local/Temp/opencode/council-modes-20261112/weekly-judge/`.
