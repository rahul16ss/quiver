---
name: due-diligence
version: 1.0.0
purpose: Guide for producing comprehensive due diligence reports
---

# Skill: Due Diligence

You are producing a due diligence report for an M&A or investment transaction. Follow this structure and these rules.

## Output Structure

1. **Header**: Target company, deal type (acquisition / investment), date, team
2. **Executive Summary**: Key findings, overall risk assessment, go/no-go recommendation
3. **Financial DD**: Revenue, profitability, cash flow, debt, working capital
4. **Legal DD**: Corporate structure, contracts, litigation, IP, regulatory
5. **Commercial DD**: Market, competition, customers, pipeline
6. **Technical DD** (if applicable): Architecture, tech debt, security, scalability
7. **Red Flags**: Numbered list of material issues with evidence
8. **Open Questions**: Items requiring further investigation
9. **Sources**: Full list with URLs

## Rules

- **Separate confirmed facts from estimates.** Use "Confirmed:" and "Estimated:" labels.
- **Every claim has a citation.** Financial figures cite filings or press releases. Legal items cite contracts or court records.
- **Red flags are evidence-based.** A red flag must include: (1) what was found, (2) why it's concerning, (3) source.
- **Open questions are explicit.** Don't hide gaps — list them as "OPEN-Q-001: Confirm customer concentration — only 2 of top 10 customers publicly disclosed."
- **Risk assessment is holistic.** Consider financial, legal, commercial, and technical risks together.
- **Note data limitations.** If the DD is based only on public sources, state: "This assessment is based on publicly available information. A full DD with access to confidential data may reveal additional findings."

## Financial DD Checklist

- [ ] 3-year revenue history with growth rates
- [ ] Gross/operating/net margins with trend
- [ ] Cash flow statement analysis (operating, investing, financing)
- [ ] Debt schedule (total debt, covenants, maturity)
- [ ] Working capital position and trend
- [ ] Key metrics for industry (e.g., ARR for SaaS, AUM for fintech)

## Legal DD Checklist

- [ ] Corporate structure and cap table
- [ ] Material contracts (top 5 by value)
- [ ] Pending or threatened litigation
- [ ] IP portfolio (patents, trademarks, trade secrets)
- [ ] Regulatory compliance status
- [ ] Employment agreements and key person dependencies

## What NOT to Do

- Don't state "no issues found" without explaining what was checked
- Don't omit a category because data wasn't available — note it as "Data not available — requires information access"
- Don't present estimates as confirmed facts
- Don't minimize red flags — let the reader assess severity