# Preview Auto-Test

The orchestrator now runs an automatic preview probe after publish-like tasks when a VIVERSE preview URL is available.

## What It Does

1. Extracts preview URL from task output/context.
2. Runs HTTP probe against `worlds.viverse.com` preview URL.
3. Saves artifacts under:
   - `artifacts/preview-tests/preview-*.json`
   - `artifacts/preview-tests/preview-*.html`
4. If Playwright is available, runs browser runtime probe in two contexts (host/joiner) and saves:
   - `artifacts/preview-tests/browser-*/browser-report.json`
   - screenshots/logs for both contexts.
5. Injects probe summary and artifact paths into project context for Reviewer.

## Environment Flags

- `VIVERSE_BROWSER_AUTOTEST=1` (default): attempt browser runtime probe.
- `VIVERSE_BROWSER_AUTOTEST=0`: disable browser runtime probe (HTTP probe only).

## Playwright Requirement

Browser runtime probe requires `playwright` package and Chromium runtime.
If unavailable, probe is marked `skip` for browser stage and workflow continues with HTTP-level preview evidence.
