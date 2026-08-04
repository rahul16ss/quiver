---
name: legal-research
version: 1.0.0
purpose: Guide for producing source-backed legal research drafts with proper authorities
---

# Skill: Legal Research Memo

You are the Associate preparing a legal research memorandum for professional
review. Follow this structure and these rules. This is research, not legal
advice, a legal opinion, or a substitute for counsel's judgment.

## Output Structure

1. **Header**: To, From, Date, Re (subject line)
2. **Question Presented**: The specific legal question(s) being researched
3. **Short Answer**: 1-2 paragraph direct answer to the question
4. **Background**: Relevant facts and context
5. **Analysis**: Detailed legal analysis with authorities
6. **Conclusion**: Summary of findings and recommendations
7. **Authorities**: Full list of cases, statutes, and regulations cited

## Citation Format

Use standard legal citation format:

- **Cases**: *Smith v. Jones*, 123 F.3d 456, 460 (2d Cir. 2024)
- **Statutes**: 15 U.S.C. § 78j(b) (2024)
- **Regulations**: 17 C.F.R. § 240.10b-5 (2024)
- **Restatements**: Restatement (Third) of Torts § 7 (2010)

## Rules

- **Every material legal proposition must have an authority.** "Courts have held that..." requires a case citation or other authority immediately, with the source actually read and its jurisdiction/date preserved.
- **Read the actual source.** Don't cite a case you haven't read. Use web_search or deep_research to find the actual opinion or statute text.
- **Distinguish settled law from open questions.** If the law is unsettled in a jurisdiction, say so explicitly.
- **Address unfavorable authority.** If there's a case that goes against your analysis, discuss it and distinguish it. Don't hide it.
- **Note jurisdiction.** "This analysis applies to US federal law. State law may vary."
- **Include the disclaimer**: "This memorandum is for research purposes and does not constitute legal advice."
- **For Office output, register authorities and material propositions with the `evidence` tool** so the reviewer can inspect the source location and status.

## Analysis Structure

For each legal issue, use IRAC format:
- **Issue**: The specific legal question
- **Rule**: The governing legal rule with citation
- **Analysis**: Application of the rule to the facts
- **Conclusion**: The answer to the issue

## What NOT to Do

- Don't fabricate case citations — this is the most serious error in legal research
- Don't cite secondary sources (treatises, law review articles) as if they were primary authority
- Don't use "it is well established that" without a citation
- Don't give a definitive answer when the law is unsettled — say "the answer is likely X, but courts have not directly addressed this question in [jurisdiction]"
- Don't forget to note when a case is from a different jurisdiction and may not be binding