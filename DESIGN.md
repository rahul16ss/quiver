---
name: Quiver-Terminal
description: Visual identity for Quiver's line-mode CLI and full-screen dashboard TUI.
colors:
  primary: "#6366f1"
  secondary: "#94a3b8"
  background: "#080a0f"
  text-primary: "#e2e8f0"
  text-secondary: "#94a3b8"
  accent: "#818cf8"
  border: "#1e293b"
  border-active: "#4f46e5"
  success: "#10b981"
  warning: "#f59e0b"
  danger: "#ef4444"
  panel-bg: "#0f172a"
  info: "#3b82f6"
spacing:
  sm: 4px
  md: 8px
  lg: 16px
rounded:
  sm: 2px
  md: 4px
typography:
  h1:
    fontFamily: monospace
    fontSize: 18px
    fontWeight: 700
  body:
    fontFamily: monospace
    fontSize: 12px
    fontWeight: 400
  label:
    fontFamily: monospace
    fontSize: 11px
    fontWeight: 600
components:
  prompt-user:
    textColor: "{colors.success}"
  prompt-agent:
    textColor: "{colors.primary}"
  status-ok:
    textColor: "{colors.success}"
  status-warn:
    textColor: "{colors.warning}"
  status-error:
    textColor: "{colors.danger}"
  status-info:
    textColor: "{colors.info}"
  status-dry:
    textColor: "{colors.accent}"
  panel-surface:
    backgroundColor: "{colors.panel-bg}"
  panel-border:
    backgroundColor: "{colors.border}"
  panel-border-active:
    backgroundColor: "{colors.border-active}"
  log-body:
    textColor: "{colors.text-primary}"
  log-muted:
    textColor: "{colors.text-secondary}"
  tool-name:
    textColor: "{colors.success}"
  approval-frame:
    backgroundColor: "{colors.warning}"
---

## Overview

Quiver's terminal interface follows the aesthetic of a **late-2000s systems console crossed with a modern IDE status bar** — think `htop` information density, `git` CLI clarity, and the calm restraint of a flight instrument panel. The audience is a developer at a keyboard who needs to read logs for hours without eye strain.

This is not a marketing landing page. It is an **instrument panel**: information-dense, monospace, low-chrome, and honest about state. Color is a signal, not decoration.

## Colors

A single dark canvas with one cool accent and three semantic signals.

- **Background** `{colors.background}` — deep midnight shell. Never pure black; reduces halation on OLED terminals.
- **Panel** `{colors.panel-bg}` — slightly lifted surface for sidebars and input wells.
- **Text Primary** `{colors.text-primary}` — body copy, agent responses, tool output.
- **Text Secondary** `{colors.text-secondary}` — timestamps, metadata, helper hints. Never used for actionable text.
- **Primary** `{colors.primary}` — agent prompt prefix, brand accents, focused borders. The "Quiver voice."
- **Accent** `{colors.accent}` — dry-run previews and secondary highlights. Slightly lighter than primary.
- **Success** `{colors.success}` — user prompt prefix, completed steps, `[OK]` status tag.
- **Warning** `{colors.warning}` — approval gates, `[WARN]` tag, interrupts.
- **Danger** `{colors.danger}` — failures, `[ERROR]` tag, declined actions.
- **Info** `{colors.info}` — system logs routed into the dashboard, `[INFO]` tag.
- **Border** `{colors.border}` — idle pane frames. **Border Active** `{colors.border-active}` — focused input or selected pane.

Status is **never conveyed by color alone**. Every status line includes a text tag: `[OK]`, `[WARN]`, `[ERROR]`, `[INFO]`, `[DRY]`.

## Typography

Monospace everywhere. Quiver is a text instrument; proportional fonts break column alignment.

- **Headings** use `{typography.h1}` — short labels only (session title, pane names). No display-size hero text in the terminal.
- **Body** uses `{typography.body}` — logs, tool output, agent stream.
- **Labels** use `{typography.label}` — status bar metadata, `[OK]` prefixes.

Uppercase is reserved for pane titles (`CONTEXT MANIFEST`, `PROMPT INPUT`), not for sentences.

## Layout

Two surfaces share this design system:

### Line-mode CLI (`quiver`)
Single-column transcript: status lines on stderr, conversation on stdout. No full-screen takeover unless the user runs the dashboard.

### Dashboard TUI (`npm run dashboard`)
Four-region grid:
1. **Header** — session id, model, connection state.
2. **Sidebar (25%)** — skills, memory, tools manifest.
3. **Main log (75%)** — scrollable agent history.
4. **Footer** — prompt input with active border `{colors.border-active}`.

## Elevation & Depth

Terminals have no real z-axis. Depth is shown only through:
- Border weight (single-line box drawing)
- Background step (`background` → `panel-bg`)
- Active border highlight on focus

No drop shadows, no gradients, no translucent "glass" panels.

## Shapes

- Pane corners use ASCII box drawing (`─`, `│`, `╭`, `╰`).
- Internal padding follows `{spacing.md}` at minimum between content and border.
- Progress bars use block characters (`█` / `░`), not animated shimmer.

## Components

| Component | Role |
| --- | --- |
| `prompt-user` | `user>` prefix before human input |
| `prompt-agent` | `agent>` prefix before model output |
| `status-ok` / `status-warn` / `status-error` / `status-info` / `status-dry` | Accessible status line tags |
| `panel-surface` | Sidebar / panel fill |
| `panel-border` / `panel-border-active` | TUI pane frame colors (idle / focused) |
| `log-body` / `log-muted` | Dashboard log stream |
| `tool-name` | Tool invocation labels in the action panel |
| `approval-frame` | Security permission highlight |

## Do's and Don'ts

- **Do** treat the terminal as a long-session reading surface. Optimize for legibility over flair.
- **Do** keep agent narration short; let tool panels carry detail.
- **Do** use `[TAG]` prefixes on every status line for screen-reader and log-pipe compatibility.
- **Do** respect `NO_COLOR` and non-TTY output — fall back to plain text gracefully.
- **Do** fold large code blocks in approval previews; never dump 200 lines into a permission dialog.
- **Don't** use emoji as the only indicator of success or failure.
- **Don't** use full-screen spinners when a one-line `[INFO]` step log is clearer.
- **Don't** paint entire rows in saturated color; color a word or tag, keep the rest `{colors.text-primary}`.
- **Don't** use proportional fonts, rounded "card" layouts, or gradient backgrounds in the TUI.
- **Don't** hardcode hex values in source — read tokens from this file via `design_tokens.ts`.
