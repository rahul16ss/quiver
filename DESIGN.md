---
name: Quiver-TUI
colors:
  primary: "#6366f1"
  secondary: "#94a3b8"
  background: "#080a0f"
  text-primary: "#e2e8f0"
  text-secondary: "#94a3b8"
  accent: "#6366f1"
  border: "#1e293b"
  border-active: "#4f46e5"
  success: "#10b981"
  warning: "#f59e0b"
  danger: "#ef4444"
  panel-bg: "#0f172a"
spacing:
  sm: "4px"
  md: "8px"
  lg: "16px"
rounded:
  sm: "2px"
  md: "4px"
typography:
  h1:
    fontFamily: "monospace"
    fontSize: "18px"
    fontWeight: 700
  body:
    fontFamily: "monospace"
    fontSize: "12px"
---

# Overview
This document specifies the design tokens and layout aesthetics for the **Quiver Terminal User Interface (TUI)**. Quiver transitions from line-based prompts to a modern, responsive, component-driven dashboard, designed to run in GPU/native terminal environments.

## Colors
The terminal UI utilizes a dark, tech-focused palette mimicking a high-end IDE.
*   **Primary ({colors.primary}):** Bright Indigo for main accents and highlights.
*   **Secondary ({colors.secondary}):** Soft slate gray for subtitles and inactive status indicators.
*   **Background ({colors.background}):** Deep midnight blue/black for overall shell.
*   **Text Primary ({colors.text-primary}):** Crisp off-white for high-contrast output.
*   **Text Secondary ({colors.text-secondary}):** Muted gray for timestamps, logs, and helper labels.
*   **Accent ({colors.accent}):** Indigo for primary highlights and focus indicators.
*   **Border ({colors.border}):** Dark slate to separate panes cleanly.
*   **Success ({colors.success}):** Muted emerald for successful tool executions and ready states.
*   **Warning ({colors.warning}):** Warm amber for approval requests and pending events.
*   **Danger ({colors.danger}):** Soft rose for exceptions and failed commands.

## Typography
Monospaced font stacks are required. Standard layout headings use uppercase ascii block lettering or bold-faced text characters.

## Layout
The dashboard layout is divided into four main sections using standard Flexbox boxes:
1.  **Header (Horizontal Block):** Top status bar with session information.
2.  **Left Column (Vertical Stack, 25% width):** Dynamic list of active tools, loaded skills, and current memory blocks.
3.  **Right Column (Vertical Stack, 75% width):** Response history and dynamic streaming panel.
4.  **Footer (Horizontal Input Block):** Text prompt entry area.

## Shapes
Panels are separated by `{shapes.border-style}` frames. Standard internal components use `{shapes.padding}` characters of breathing room to avoid visual clutter.

## Components
All interactive boxes utilize dynamic border highlighting when active, switching from `{colors.border}` to `{colors.border-active}`.
