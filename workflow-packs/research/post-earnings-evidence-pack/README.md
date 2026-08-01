# Investment Research — Post-Earnings Evidence Pack

**Maturity**: `demo-ready` (Executable reference implementation)  
**Family**: `research`  
**Workflow**: `post-earnings-evidence-pack`

## Overview

This workflow pack is designed for buy-side and sell-side research teams. It processes quarterly earnings results, financial models, SEC filings, management transcripts, and consensus estimates to build a structured post-earnings evidence pack with verifiable lineage.

## Demo Execution

Run the deterministic demo:

```bash
npm run demo:post-earnings
```

## Generated Outputs

- `expected-output/Post_Earnings_Evidence_Pack.html` — Interactive evidence map connecting key financial metrics (Revenue, EPS, Gross Margin, ARR, Guidance) to source files.
- `expected-output/Post_Earnings_Review_Checklist.md` — Unresolved items, guidance shifts, and management risks for reviewer sign-off.
- `expected-output/Post_Earnings_Run_Record.json` — Input hashes, execution timestamp, and acceptance status.

## Status

> **Demo Ready**: Executable reference implementation with deterministic data fixtures and 6/6 automated acceptance checks.
