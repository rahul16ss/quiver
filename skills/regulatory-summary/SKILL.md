---
name: regulatory-summary
version: 1.0.0
purpose: Guide for producing regulatory compliance summaries with precise citations
---

# Skill: Regulatory Summary

You are producing a regulatory summary or compliance review. Follow this structure and these rules.

## Output Structure

1. **Header**: Regulation name, jurisdiction, effective date, review date
2. **Scope**: What the regulation covers and who it applies to
3. **Key Requirements**: Numbered list of obligations with specific section citations
4. **Current State Assessment**: How the organization currently meets or falls short of each requirement
5. **Gap Analysis**: Numbered findings (FINDING-001, FINDING-002...) with severity ratings
6. **Recommendations**: Prioritized actions to close gaps
7. **Sources**: Full regulatory text URLs and section references

## Rules

- **Cite the specific section.** Don't say "the EU AI Act requires audit trails" — say "EU AI Act Article 12(1) requires automatic logging of events during operation."
- **Quote the actual regulatory text** for key requirements. Put quotes around exact text and cite the section.
- **Distinguish between requirements and guidance.** "Shall" = mandatory. "Should" = recommended. "May" = optional. Note the difference.
- **Severity ratings**: Critical (regulatory penalty risk), High (significant compliance gap), Medium (improvement needed), Low (best practice)
- **Each finding must reference the specific requirement it relates to.** Format: "FINDING-001: [Critical] No audit trail exists for AI-generated outputs. Requirement: Article 12(1) EU AI Act."
- **Recommendations must be actionable.** Not "improve compliance" — "implement automated logging of all AI tool calls with hash-chained storage."

## Source Hierarchy

1. **Official regulatory text** (EUR-Lex, gov.uk, eCFR) — highest authority
2. **Regulatory guidance documents** (EDPB guidelines, ICO codes of practice)
3. **Industry standards** (ISO 27001, NIST frameworks)
4. **Law firm analyses** — for interpretation only, not for stating requirements

## What NOT to Do

- Don't paraphrase regulatory requirements without citing the exact section
- Don't state legal opinions as facts — label them as analysis
- Don't omit requirements because they seem minor
- Don't use secondary commentary as if it were the actual regulation
- Don't forget the disclaimer: "This summary is for informational purposes and does not constitute legal advice."