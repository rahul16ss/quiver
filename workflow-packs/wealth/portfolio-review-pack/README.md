# Wealth & Portfolio Communication — Portfolio Review Pack

**Maturity**: `demo-ready` (Executable reference implementation)  
**Family**: `wealth`  
**Workflow**: `portfolio-review-pack`

## Overview

This workflow pack is designed for wealth managers, family offices, RIAs, and outsourced CIOs. It processes portfolio holdings, benchmark data, manager commentary, and risk exposure metrics into client-ready portfolio review packs with IPS constraint verification.

## Demo Execution

Run the deterministic demo:

```bash
npm run demo:portfolio-review
```

## Generated Outputs

- `expected-output/Portfolio_Review_Pack.html` — Interactive portfolio review pack comparing asset allocations, weighted yield, ESG ratings, and benchmark performance.
- `expected-output/Portfolio_Review_Checklist.md` — IPS constraint breach alerts (AAPL 6.5%, MSFT 7.2% vs 6.0% cap), rebalancing notes, and advisor sign-off items.
- `expected-output/Portfolio_Review_Run_Record.json` — Input file hashes, IPS rules applied, and acceptance verification status.

## Status

> **Demo Ready**: Executable reference implementation with deterministic data fixtures and 6/6 automated acceptance checks.
