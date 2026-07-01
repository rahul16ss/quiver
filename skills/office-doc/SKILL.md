---
name: office-doc
description: Create, edit, and manage Office documents (.docx, .xlsx, .pptx) using the office_doc tool (powered by OfficeCLI). Use when the user needs Word, Excel, or PowerPoint documents — reports, spreadsheets, presentations, investment briefs, compliance reviews, etc.
---

# Office Document Creation

Use the `office_doc` tool to create and edit Office documents. The tool wraps the
OfficeCLI engine — a single binary that handles .docx, .xlsx, and .pptx files
without requiring Microsoft Office to be installed.

## When to Use

- User asks for a Word document, Excel spreadsheet, or PowerPoint presentation
- User needs a report, memo, brief, or any formatted document
- User wants to create an investment brief, compliance review, research report
- User needs a financial model, data dashboard, or analysis spreadsheet
- User wants a pitch deck, board presentation, or slide deck

## Quick Start

### Word (.docx)

```
// Create a blank document
office_doc: { action: "create", file: "report.docx" }

// Add a heading
office_doc: { action: "add", file: "report.docx", parent: "/body", type: "paragraph", props: { text: "Executive Summary", style: "Heading1" } }

// Add body text
office_doc: { action: "add", file: "report.docx", parent: "/body", type: "paragraph", props: { text: "Revenue increased by 25% year-over-year." } }

// Add a table
office_doc: { action: "add", file: "report.docx", parent: "/body", type: "table", props: { rows: "3", cols: "3" } }

// Set table cell content
office_doc: { action: "set", file: "report.docx", path: "/body/tbl[1]/tr[1]/tc[1]", props: { text: "Quarter" } }

// Save
office_doc: { action: "save", file: "report.docx" }

// View content
office_doc: { action: "view", file: "report.docx", mode: "text" }
```

### Excel (.xlsx)

```
// Create a blank workbook
office_doc: { action: "create", file: "data.xlsx" }

// Set cell values (use set with cell paths)
office_doc: { action: "set", file: "data.xlsx", path: "/Sheet1/A1", props: { value: "Quarter", bold: "true" } }
office_doc: { action: "set", file: "data.xlsx", path: "/Sheet1/B1", props: { value: "Revenue", bold: "true" } }
office_doc: { action: "set", file: "data.xlsx", path: "/Sheet1/A2", props: { value: "Q1 2026" } }
office_doc: { action: "set", file: "data.xlsx", path: "/Sheet1/B2", props: { value: "1250000" } }

// Save and view
office_doc: { action: "save", file: "data.xlsx" }
office_doc: { action: "view", file: "data.xlsx", mode: "text" }
```

### PowerPoint (.pptx)

```
// Create a blank deck
office_doc: { action: "create", file: "deck.pptx" }

// Add a slide (slides go at root "/", not under /presentation)
office_doc: { action: "add", file: "deck.pptx", parent: "/", type: "slide" }

// Add a title textbox
office_doc: { action: "add", file: "deck.pptx", parent: "/slide[1]", type: "textbox", props: { text: "Q4 Report", x: "1000000", y: "500000", w: "8000000", h: "1000000" } }

// Add a content textbox
office_doc: { action: "add", file: "deck.pptx", parent: "/slide[1]", type: "textbox", props: { text: "Revenue grew 25%", x: "1000000", y: "2000000", w: "8000000", h: "500000" } }

// Save and view
office_doc: { action: "save", file: "deck.pptx" }
office_doc: { action: "view", file: "deck.pptx", mode: "text" }
```

### Batch Operations (efficient for multiple edits)

```
office_doc: {
  action: "batch",
  file: "report.docx",
  commands: [
    { command: "add", parent: "/body", type: "paragraph", props: { text: "Introduction" } },
    { command: "add", parent: "/body", type: "paragraph", props: { text: "Methodology" } },
    { command: "add", parent: "/body", type: "paragraph", props: { text: "Results" } },
    { command: "add", parent: "/body", type: "paragraph", props: { text: "Conclusion" } }
  ]
}
```

## Key Concepts

### Paths
- **Word**: `/body` (container), `/body/p[1]` (paragraph), `/body/tbl[1]/tr[1]/tc[1]` (table cell)
- **Excel**: `/Sheet1/A1` (cell), `/Sheet1/row[1]` (row), `/Sheet1` (sheet)
- **PowerPoint**: `/slide[1]` (slide), `/slide[1]/shape[1]` (shape/textbox)
- Paths are **1-based** (first element is [1], not [0])
- Always quote paths with brackets in shell: `"/slide[1]"` not `/slide[1]`

### Properties
- All property values are **strings** (even booleans/numbers)
- Common Word props: `text`, `style` (Heading1/Heading2/Normal), `bold`, `italic`, `color`, `font`, `size`
- Common Excel props: `value`, `bold`, `italic`, `formula`, `format`
- Common PPT props: `text`, `x`, `y`, `w`, `h` (in EMU units), `font`, `size`, `color`, `fill`

### Workflow
1. **Create** the document with `action: "create"`
2. **Add** elements with `action: "add"` (paragraphs, tables, slides, shapes)
3. **Set** properties with `action: "set"` (cell values, formatting)
4. **Save** with `action: "save"` (flushes to disk)
5. **View** with `action: "view"` to verify content
6. **Validate** with `action: "validate"` to check for errors

### Help
When unsure about available element types or properties:
```
office_doc: { action: "help", file: "", format: "docx" }
office_doc: { action: "help", file: "", format: "docx", element: "paragraph" }
office_doc: { action: "help", file: "", format: "xlsx" }
office_doc: { action: "help", file: "", format: "pptx" }
```

## Common Patterns

### Investment Brief (Word)
1. Create .docx
2. Add Heading1: "Investment Brief: [Company Name]"
3. Add Heading2: "Executive Summary" + paragraph
4. Add Heading2: "Market Opportunity" + paragraph
5. Add Heading2: "Financial Performance" + table (revenue, growth, margins)
6. Add Heading2: "Risk Factors" + bullet paragraphs
7. Add Heading2: "Recommendation" + paragraph
8. Save and validate

### Financial Model (Excel)
1. Create .xlsx
2. Set header row: Quarter, Revenue, Costs, Profit, Margin
3. Set data rows with values and formulas
4. Add formatting (bold headers, number formats)
5. Save and view

### Pitch Deck (PowerPoint)
1. Create .pptx
2. Add slides with title + content textboxes
3. Use EMU coordinates for positioning (1 inch = 914400 EMU)
4. Save and view

## Important Notes

- **No Microsoft Office needed** — OfficeCLI handles all document creation natively
- **Resident mode** — OfficeCLI keeps files in memory for faster subsequent commands
- **Always save** before the user opens the file in another application
- **Validate** after complex operations to catch any structural issues
- **Use batch** for multiple operations — it's more efficient than individual calls