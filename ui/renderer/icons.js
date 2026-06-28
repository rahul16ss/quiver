// ── Tool call icons ──────────────────────────────────────────────────
// Adapted from goose's icon system (github.com/aaif-goose/goose)
// 11×11px inline SVG with rounded-rect backgrounds, distinct colors per category.
// Licensed under Apache 2.0 (same as Quiver).

const TOOL_ICONS_SVG = {
  // Terminal — dark bg, green prompt
  terminal: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#1C1C1E"/><path d="M2 3L2 2L6 2L6 3L2 3Z" fill="#19FF4F"/></svg>`,

  // FileEdit — dark gradient, white edit shape
  fileEdit: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="url(#fe-g)"/><path d="M8.97 2.03L8.97 4.78L2.09 4.78L2.09 3.41C2.09 2.65 2.71 2.03 3.47 2.03L8.97 2.03Z" fill="white"/><path d="M5.03 6.03L5.03 9.03L2.03 9.03L2.03 7.53C2.03 6.70 2.30 6.03 2.63 6.03L5.03 6.03Z" fill="white"/><defs><linearGradient id="fe-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop/><stop offset="1" stopColor="#383838"/></linearGradient></defs></svg>`,

  // FileText — orange gradient, white diagonal line
  fileText: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="url(#ft-g)"/><path fillRule="evenodd" clipRule="evenodd" d="M8.74 2.26C9.01 2.53 9.01 2.97 8.74 3.24L3.24 8.74C2.97 9.01 2.53 9.01 2.26 8.74C1.99 8.47 1.99 8.03 2.26 7.76L7.76 2.26C8.03 1.99 8.47 1.99 8.74 2.26Z" fill="white"/><defs><linearGradient id="ft-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#FFB645"/><stop offset="1" stopColor="#FF8735"/></linearGradient></defs></svg>`,

  // FilePlus — orange-yellow gradient, white plus
  filePlus: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="url(#fp-g)"/><rect x="2" y="5" width="7" height="1" rx="0.5" fill="white"/><rect x="6" y="2" width="7" height="1" rx="0.5" transform="rotate(90 6 2)" fill="white"/><defs><linearGradient id="fp-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#FF9A00"/><stop offset="1" stopColor="#FFC800"/></linearGradient></defs></svg>`,

  // Search — light gray gradient, dark circle
  search: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="url(#se-g)"/><path d="M7.56 5.5C7.56 6.64 6.64 7.56 5.5 7.56C4.36 7.56 3.44 6.64 3.44 5.5C3.44 4.36 4.36 3.44 5.5 3.44C6.64 3.44 7.56 4.36 7.56 5.5Z" fill="#2D2D2E"/><defs><linearGradient id="se-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#D2D5DA"/><stop offset="1" stopColor="#8B8E95"/></linearGradient></defs></svg>`,

  // Globe — blue gradient, world circle
  globe: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><g clipPath="url(#gl-c)"><rect width="11" height="11" rx="2" fill="white"/><path d="M10.31 5.5C10.31 8.16 8.16 10.31 5.5 10.31C2.84 10.31 0.69 8.16 0.69 5.5C0.69 2.84 2.84 0.69 5.5 0.69C8.16 0.69 10.31 2.84 10.31 5.5Z" fill="url(#gl-g)"/></g><defs><linearGradient id="gl-g" x1="5.5" y1="0.69" x2="5.5" y2="10.31" gradientUnits="userSpaceOnUse"><stop stopColor="#00CAF7"/><stop offset="1" stopColor="#0B54DE"/></linearGradient><clipPath id="gl-c"><rect width="11" height="11" rx="2" fill="white"/></clipPath></defs></svg>`,

  // Code2 — dark bg, green bar
  code2: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#1C1C1E"/><rect x="2" y="5" width="7" height="1" rx="0.5" fill="#19FF4F"/></svg>`,

  // Eye — blue gradient, white eye with dark pupil
  eye: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="url(#ey-g)"/><path d="M1.38 5.5C1.38 4.36 2.30 3.44 3.44 3.44H7.56C8.70 3.44 9.63 4.36 9.63 5.5C9.63 6.64 8.70 7.56 7.56 7.56H3.44C2.30 7.56 1.38 6.64 1.38 5.5Z" fill="white"/><path d="M6.53 5.5C6.53 6.07 6.07 6.53 5.5 6.53C4.93 6.53 4.47 6.07 4.47 5.5C4.47 4.93 4.93 4.47 5.5 4.47C6.07 4.47 6.53 4.93 6.53 5.5Z" fill="black"/><defs><linearGradient id="ey-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#00A2FF"/><stop offset="1" stopColor="#5A6DFF"/></linearGradient></defs></svg>`,

  // Brain — dark gradient, pink diamond
  brain: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#3E3E3E"/><rect width="11" height="11" rx="2" fill="url(#br-g)"/><path d="M5.5 2.06L1.38 5.5L5.5 8.94L9.63 5.5L5.5 2.06Z" fill="#E74786"/><defs><linearGradient id="br-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop/><stop offset="1" stopColor="#323232"/></linearGradient></defs></svg>`,

  // Save — dark red bg, pink diamond
  save: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#C32361"/><path d="M5.5 2.06L1.38 5.5L5.5 8.94L9.63 5.5L5.5 2.06Z" fill="#E74786"/></svg>`,

  // Delegate — indigo bg, white arrow + dot
  delegate: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#6366F1"/><path d="M3 4L6 5.5L3 7" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><circle cx="8" cy="5.5" r="1" fill="white"/></svg>`,

  // Numbers — green gradient, white bars
  numbers: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="url(#nu-g)"/><path d="M4.81 3.44C4.81 3.06 5.12 2.75 5.5 2.75C5.88 2.75 6.19 3.06 6.19 3.44V7.56C6.19 7.94 5.88 8.25 5.5 8.25C5.12 8.25 4.81 7.94 4.81 7.56V3.44Z" fill="white"/><path d="M2.06 6.19C2.06 5.81 2.37 5.5 2.75 5.5C3.13 5.5 3.44 5.81 3.44 6.19V7.56C3.44 7.94 3.13 8.25 2.75 8.25C2.37 8.25 2.06 7.94 2.06 7.56V6.19Z" fill="white"/><path d="M8.25 4.13C7.87 4.13 7.56 4.43 7.56 4.81V7.56C7.56 7.94 7.87 8.25 8.25 8.25C8.63 8.25 8.94 7.94 8.94 7.56V4.81C8.94 4.43 8.63 4.13 8.25 4.13Z" fill="white"/><defs><linearGradient id="nu-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#73FA80"/><stop offset="1" stopColor="#00D648"/></linearGradient></defs></svg>`,

  // Tool — dark bg, white bar
  tool: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#1E1E20"/><rect x="2" y="5" width="7" height="1" rx="0.5" fill="white"/></svg>`,

  // Archive — dark bg, stacked layers
  archive: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#1E1E20"/><path d="M1.38 6.19H9.63V8.25C9.63 8.63 9.32 8.94 8.94 8.94H2.06C1.68 8.94 1.38 8.63 1.38 8.25V6.19Z" fill="#DBD7CE"/><path d="M1.38 6.19H9.63V7.56H1.38V6.19Z" fill="#434343"/><path d="M1.38 4.81H9.63V6.19H1.38V4.81Z" fill="white"/><path d="M1.38 3.44H9.63V4.81H1.38V3.44Z" fill="#616161"/><path d="M1.38 2.75C1.38 2.37 1.68 2.06 2.06 2.06H8.94C9.32 2.06 9.63 2.37 9.63 2.75V3.44H1.38V2.75Z" fill="#9F9F9F"/></svg>`,

  // Harddrive — dark bg, white circle
  harddrive: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#1E1E20"/><path d="M5 3.5C5 4.33 4.33 5 3.5 5C2.67 5 2 4.33 2 3.5C2 2.67 2.67 2 3.5 2C4.33 2 5 2.67 5 3.5Z" fill="white"/></svg>`,

  // Monitor — white bg, red circle
  monitor: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="white"/><path d="M9.63 5.5C9.63 7.78 7.78 9.63 5.5 9.63C3.22 9.63 1.38 7.78 1.38 5.5C1.38 3.22 3.22 1.38 5.5 1.38C7.78 1.38 9.63 3.22 9.63 5.5Z" fill="#E60023"/></svg>`,

  // Camera — light gradient, dark camera body
  camera: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="url(#ca-g)"/><path d="M1.38 3.44C1.38 3.06 1.68 2.75 2.06 2.75H8.94C9.32 2.75 9.63 3.06 9.63 3.44V7.56C9.63 7.94 9.32 8.25 8.94 8.25H2.06C1.68 8.25 1.38 7.94 1.38 7.56V3.44Z" fill="#2F2F31"/><path d="M6.53 5.5C6.53 6.07 6.07 6.53 5.5 6.53C4.93 6.53 4.47 6.07 4.47 5.5C4.47 4.93 4.93 4.47 5.5 4.47C6.07 4.47 6.53 4.93 6.53 5.5Z" fill="white"/><defs><linearGradient id="ca-g" x1="5.5" y1="0" x2="5.5" y2="11" gradientUnits="userSpaceOnUse"><stop stopColor="#E2E3F7"/><stop offset="1" stopColor="#978E8F"/></linearGradient></defs></svg>`,

  // GitHub — dark bg, white octocat silhouette (simplified)
  github: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#24292F"/><path d="M5.5 1.38C3.55 1.38 1.97 2.96 1.97 4.91C1.97 6.46 2.97 7.79 4.37 8.26C4.54 8.29 4.60 8.18 4.60 8.09V7.55C3.64 7.76 3.44 7.09 3.44 7.09C3.29 6.70 3.07 6.60 3.07 6.60C2.76 6.39 3.09 6.39 3.09 6.39C3.43 6.41 3.61 6.74 3.61 6.74C3.91 7.25 4.41 7.10 4.60 7.02C4.63 6.80 4.72 6.65 4.82 6.57C4.10 6.49 3.34 6.21 3.34 4.86C3.34 4.47 3.48 4.16 3.61 3.91C3.58 3.83 3.46 3.48 3.64 3.01C3.64 3.01 3.93 2.92 4.60 3.36C4.88 3.28 5.19 3.24 5.5 3.24C5.81 3.24 6.12 3.28 6.40 3.36C7.07 2.92 7.36 3.01 7.36 3.01C7.54 3.48 7.42 3.83 7.39 3.91C7.52 4.16 7.66 4.47 7.66 4.86C7.66 6.21 6.90 6.49 6.18 6.57C6.30 6.67 6.40 6.87 6.40 7.18V8.09C6.40 8.18 6.46 8.29 6.63 8.26C8.03 7.79 9.03 6.46 9.03 4.91C9.03 2.96 7.45 1.38 5.5 1.38Z" fill="white"/></svg>`,

  // Check — green bg, white checkmark
  check: `<svg width="14" height="14" viewBox="0 0 11 11" fill="none" xmlns="http://www.w3.org/2000/svg"><rect width="11" height="11" rx="2" fill="#22C55E"/><path d="M3 5.5L4.5 7L8 3.5" stroke="white" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
};

// ── Map Quiver tool names to icon keys ────────────────────────────────
const TOOL_ICON_MAP = {
  view_file: "fileText",
  write_file: "fileEdit",
  replace_content: "fileEdit",
  apply_patch: "fileEdit",
  format_code: "fileEdit",
  list_dir: "eye",
  glob: "search",
  grep_search: "search",
  run_command: "terminal",
  log_tokens: "terminal",
  run_tests: "code2",
  create_tool: "filePlus",
  web_search: "globe",
  scrape_url: "globe",
  browser_control: "globe",
  deep_research: "globe",
  find_all: "search",
  entity_search: "search",
  memory_append: "save",
  memory_replace: "save",
  github: "github",
  todo_write: "numbers",
  ask_question: "terminal",
  prompt_update: "tool",
  continual_learning: "brain",
  ralph_loop: "archive",
  subagent: "delegate",
};

// ── UI chrome icons (smaller, no bg) ──────────────────────────────────
const UI_ICONS = {
  send: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M2 8L14 2L8 14L7 9L2 8Z" fill="currentColor"/></svg>`,
  stop: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="10" height="10" rx="2" fill="currentColor"/></svg>`,
  settings: `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.5"><circle cx="8" cy="8" r="2"/><path d="M8 1V3M8 13V15M1 8H3M13 8H15M3.5 3.5L4.9 4.9M11.1 11.1L12.5 12.5M3.5 12.5L4.9 11.1M11.1 4.9L12.5 3.5" stroke-linecap="round"/></svg>`,
  close: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 3L11 11M11 3L3 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  copy: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3"><rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M2 10V3C2 2.45 2.45 2 3 2H10"/></svg>`,
  edit: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3"><path d="M9 2L12 5L5 12L2 12L2 9L9 2Z" stroke-linejoin="round"/></svg>`,
  refresh: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3"><path d="M12 7C12 9.76 9.76 12 7 12C4.24 12 2 9.76 2 7C2 4.24 4.24 2 7 2C8.5 2 9.85 2.66 10.8 3.7" stroke-linecap="round"/><path d="M11 1V4H8" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  more: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><circle cx="3" cy="7" r="1.3" fill="currentColor"/><circle cx="7" cy="7" r="1.3" fill="currentColor"/><circle cx="11" cy="7" r="1.3" fill="currentColor"/></svg>`,
  chevronDown: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  chevronRight: `<svg width="12" height="12" viewBox="0 0 12 12" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 3L7.5 6L4.5 9" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  key: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3"><circle cx="4" cy="10" r="2"/><path d="M5.5 8.5L12 2M10 4L12 6M8 6L10 8" stroke-linecap="round"/></svg>`,
  time: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3"><circle cx="7" cy="7" r="5"/><path d="M7 4V7L9 8.5" stroke-linecap="round"/></svg>`,
  idea: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3"><path d="M7 1C4.79 1 3 2.79 3 5C3 6.5 3.8 7.5 4.5 8V10H9.5V8C10.2 7.5 11 6.5 11 5C11 2.79 9.21 1 7 1Z" stroke-linejoin="round"/><path d="M5 11.5H9M5.5 13H8.5" stroke-linecap="round"/></svg>`,
  attach: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg" stroke="currentColor" stroke-width="1.3"><path d="M9.5 4L5 8.5C4.45 9.05 4.45 9.95 5 10.5C5.55 11.05 6.45 11.05 7 10.5L11.5 6C12.6 4.9 12.6 3.1 11.5 2C10.4 0.9 8.6 0.9 7.5 2L3 6.5C1.9 7.6 1.9 9.4 3 10.5" stroke-linecap="round"/></svg>`,
  back: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 3L4 7L9 11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  pause: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="2" width="3" height="10" rx="1" fill="currentColor"/><rect x="8" y="2" width="3" height="10" rx="1" fill="currentColor"/></svg>`,
};

// ── Helpers ───────────────────────────────────────────────────────────

function getToolIconSvg(toolName) {
  const iconKey = TOOL_ICON_MAP[toolName];
  if (!iconKey) return TOOL_ICONS_SVG.harddrive; // fallback
  return TOOL_ICONS_SVG[iconKey];
}

function getUiIcon(name) {
  return UI_ICONS[name] || "";
}