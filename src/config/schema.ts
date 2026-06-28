/**
 * Versioned Configuration Schema — US-8.4
 *
 * Schema for the settings panel. Non-secret settings write to core.json.
 * API keys and secrets write to the OS credential store.
 */

// ─── Schema ──────────────────────────────────────────────────────────

import { config } from "../config.js";

export const CONFIG_SCHEMA_VERSION = 1;

export interface ConfigSchema {
  schema_version: number;
  model: ModelConfig;
  vision: VisionConfig;
  approvals: ApprovalsConfig;
  sync: SyncConfig;
  memory: MemoryConfig;
}

export interface ModelConfig {
  provider: string;
  model_name: string;
  base_url: string;
  api_key_ref: string; // Reference to keychain entry, not the actual key
  max_context_tokens: number;
  max_output_tokens: number;
  temperature: number;
}

export interface VisionConfig {
  enabled: boolean;
  model_name: string;
  base_url: string;
  api_key_ref: string;
}

export interface ApprovalsConfig {
  require_approval_for: string[];
  auto_approve_safe: boolean;
}

export interface SyncConfig {
  enabled: boolean;
  path: string;
  encryption_enabled: boolean;
}

export interface MemoryConfig {
  auto_extraction: boolean;
  review_required: boolean;
  decay_half_life_days: number;
  archival_threshold: number;
}

// ─── Default Config ──────────────────────────────────────────────────

export function getDefaultConfig(): ConfigSchema {
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    model: {
      provider: "ollama",
      model_name: config.llmModelName,
      base_url: config.llmBaseUrl,
      api_key_ref: "OLLAMA_API_KEY",
      max_context_tokens: config.maxContextTokens,
      max_output_tokens: 8192,
      temperature: 0.7,
    },
    vision: {
      enabled: false,
      model_name: config.visionModelName,
      base_url: config.visionModelBaseUrl,
      api_key_ref: "OLLAMA_API_KEY",
    },
    approvals: {
      require_approval_for: ["write_file", "replace_content", "run_command", "apply_patch", "create_tool"],
      auto_approve_safe: true,
    },
    sync: {
      enabled: false,
      path: "",
      encryption_enabled: true,
    },
    memory: {
      auto_extraction: true,
      review_required: true,
      decay_half_life_days: 30,
      archival_threshold: 0.5,
    },
  };
}

// ─── Validation ──────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a config schema object.
 */
export function validateConfig(config: any): ValidationResult {
  const errors: string[] = [];

  if (!config || typeof config !== "object") {
    return { valid: false, errors: ["Config must be an object"] };
  }

  if (!config.schema_version) {
    errors.push("Missing schema_version");
  }

  if (!config.model) {
    errors.push("Missing model config section");
  } else {
    if (!config.model.model_name) errors.push("model.model_name is required");
    if (!config.model.base_url) errors.push("model.base_url is required");
    if (typeof config.model.max_context_tokens !== "number" || config.model.max_context_tokens <= 0) {
      errors.push("model.max_context_tokens must be a positive number");
    }
  }

  if (!config.approvals) {
    errors.push("Missing approvals config section");
  }

  if (!config.sync) {
    errors.push("Missing sync config section");
  }

  if (!config.memory) {
    errors.push("Missing memory config section");
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Migrate a config from an older schema version.
 */
export function migrateConfig(config: any): ConfigSchema {
  const defaults = getDefaultConfig();

  if (!config || typeof config !== "object") {
    return defaults;
  }

  // Merge with defaults (ensures all fields exist)
  return {
    schema_version: CONFIG_SCHEMA_VERSION,
    model: { ...defaults.model, ...config.model },
    vision: { ...defaults.vision, ...config.vision },
    approvals: { ...defaults.approvals, ...config.approvals },
    sync: { ...defaults.sync, ...config.sync },
    memory: { ...defaults.memory, ...config.memory },
  };
}

/**
 * Get the settings sections for the GUI settings panel.
 */
export function getSettingsSections(): { id: string; label: string; fields: SettingsField[] }[] {
  return [
    {
      id: "model",
      label: "Model Provider",
      fields: [
        { key: "provider", label: "Provider", type: "select", options: ["ollama", "openrouter", "openai", "custom"] },
        { key: "model_name", label: "Model Name", type: "text" },
        { key: "base_url", label: "Base URL", type: "text" },
        { key: "api_key_ref", label: "API Key", type: "secret" },
        { key: "max_context_tokens", label: "Max Context Tokens", type: "number" },
        { key: "max_output_tokens", label: "Max Output Tokens", type: "number" },
        { key: "temperature", label: "Temperature", type: "number" },
      ],
    },
    {
      id: "vision",
      label: "Vision Model",
      fields: [
        { key: "enabled", label: "Enabled", type: "boolean" },
        { key: "model_name", label: "Vision Model Name", type: "text" },
        { key: "base_url", label: "Vision Base URL", type: "text" },
        { key: "api_key_ref", label: "Vision API Key", type: "secret" },
      ],
    },
    {
      id: "approvals",
      label: "Approvals",
      fields: [
        { key: "require_approval_for", label: "Require Approval For", type: "list" },
        { key: "auto_approve_safe", label: "Auto-approve Safe Operations", type: "boolean" },
      ],
    },
    {
      id: "sync",
      label: "Cloud Sync",
      fields: [
        { key: "enabled", label: "Sync Enabled", type: "boolean" },
        { key: "path", label: "Sync Path", type: "text" },
        { key: "encryption_enabled", label: "Encryption Enabled", type: "boolean" },
      ],
    },
    {
      id: "memory",
      label: "Memory",
      fields: [
        { key: "auto_extraction", label: "Auto Extraction", type: "boolean" },
        { key: "review_required", label: "Review Required", type: "boolean" },
        { key: "decay_half_life_days", label: "Decay Half-Life (days)", type: "number" },
        { key: "archival_threshold", label: "Archival Threshold", type: "number" },
      ],
    },
  ];
}

export interface SettingsField {
  key: string;
  label: string;
  type: "text" | "number" | "boolean" | "secret" | "select" | "list";
  options?: string[];
}