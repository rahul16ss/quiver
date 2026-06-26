# Quiver Branding Guidelines

This document outlines the visual identity, naming conventions, and branding assets for **Quiver** to maintain visual and verbal consistency across the CLI tool, Electron GUI, documentation, and community spaces.

---

<p align="center">
  <img src="branding/logo.png" alt="QUIVER Logo" width="200" />
</p>

## Brand Identity

Quiver is a minimalist, self-evolving AI coding and research harness designed for developers. The brand voice is **focused, clear, and instrumentation-oriented**. Rather than marketing-heavy decoration, Quiver focuses on dense information layout, high-contrast typography, and explicit state indicators.

---

## Naming & Capitalization Rules

To ensure a unified brand presence, follow these capitalization rules across all files, commands, and prose:

| Context | Style | Correct | Incorrect | Notes |
|:---|:---|:---|:---|:---|
| **Brand Name** | CamelCase | `Quiver` | `quiver`, `QUIVER` | Used in general prose, documentation, descriptions, and conversational messages. |
| **Logo Wordmark** | UPPERCASE | `QUIVER` | `Quiver`, `quiver` | Used in headers, main landing titles, onboarding panels, and GUI logos. |
| **CLI Command** | lowercase | `quiver` | `Quiver`, `QUIVER` | Used in terminal command invocations, scripts, shell paths, and command-line usage hints. |
| **GitHub Repository** | lowercase | `quiver` | `Quiver`, `QUIVER` | Used in repository URL slugs, npm package details, and git configurations. |
| **GUI Page / Tab Titles** | Title Case | `Quiver — Settings` | `quiver — settings` | Used in window titles, HTML browser tabs, and main application layouts. |
| **Terminal prompts** | Custom Prompts | `Q> ` | `quiver> `, `user> ` | Used as terminal prompt prefixes: Green bold `Q> ` for User, Cyan bold `Q> ` for Agent. |

---

## Color Palette

Quiver utilizes a dark, terminal-inspired palette featuring a deep background, neutral text values, a vibrant cool accent, and semantic status colors. 

> [!NOTE]
> For exact color values and token mappings, consult [DESIGN.md](DESIGN.md).

* **Dark Canvas Background**: `#080a0f` — A midnight-blue hue that reduces halation and eye strain during long-session coding.
* **Accent / Brand Color**: `#6366f1` (Indigo) — Represents the "Quiver Voice", used for focus outlines, primary buttons, and agent prompt highlights.
* **Success**: `#10b981` (Emerald) — Used for user prompts, positive confirmations, and completed tasks.
* **Warning**: `#f59e0b` (Amber) — Used for approval gates, verification alerts, and warnings.
* **Danger**: `#ef4444` (Rose) — Used for errors, failed tests, and declined actions.

---

## Logo Assets

The branding assets are preserved in the [branding/](branding/) directory of the repository:

1. **Web-Optimized Logo** ([branding/logo.png](branding/logo.png)): A lightweight (72 KB) optimized PNG for embedding in HTML files, README documents, and settings cards.
2. **High-Resolution Logo** ([branding/logo-highres.png](branding/logo-highres.png)): A high-definition (1.0 MB) source image suitable for marketing, icons, and print media.

### Asset Guidelines
* **Aspect Ratio**: Always preserve the 1:1 aspect ratio of the logo icon.
* **Margins & Spacing**: Keep a minimum safe margin of 20% around the logo mark to prevent layout crowding.
* **Drop Shadows**: In dark-mode GUI contexts, a subtle drop shadow (`filter: drop-shadow(0 0 10px rgba(99, 102, 241, 0.2))`) can be applied to give depth. Do not apply gradients or heavy borders directly onto the logo mark.
