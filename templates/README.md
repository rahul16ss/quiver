# Quiver Workspace Templates

Pre-built acceptance criteria templates for non-code workspaces. These define
what "good output" looks like for common knowledge-work deliverables.

## How to Use

1. Create a `.quiver/` directory in your workspace
2. Copy the relevant template to `.quiver/acceptance.md`
3. Customize the criteria for your specific needs
4. Quiver's maker-checker will verify each criterion before writing deliverables

```bash
# Example: set up an investment brief workspace
mkdir -p .quiver
cp templates/acceptance/investment-brief.md .quiver/acceptance.md
```

## Available Templates

| Template | Use Case | Who It's For |
|---|---|---|
| `research-report.md` | General research reports with cited sources | Analysts, researchers, consultants |
| `investment-brief.md` | Company investment analysis and recommendations | Investment analysts, portfolio managers |
| `compliance-review.md` | Regulatory compliance gap assessments | Compliance officers, risk managers |
| `due-diligence.md` | M&A / investment due diligence checklists | Deal teams, investment bankers |
| `competitive-matrix.md` | Competitive landscape comparison matrices | Strategy teams, product managers |
| `legal-research-memo.md` | Legal research memoranda with case citations | Lawyers, legal researchers |

## Customizing

Each template uses the standard acceptance.md format:

```markdown
## Section Name
- [ ] criterion description
- [ ] another criterion
```

You can add, remove, or modify criteria to match your firm's standards,
templates, and review processes. The maker-checker will evaluate each
unchecked criterion (`- [ ]`) against the workspace.

## Why This Matters

The maker-checker gate is Quiver's core differentiator — an independent
checker verifies the agent's work before it's committed. But without
acceptance criteria, the checker has nothing to verify. These templates
give non-technical users a starting point so the verification gate is
useful from day one.