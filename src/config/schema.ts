/**
 * Versioned Configuration Schema — US-8.4
 *
 * Schema for the settings panel. Non-secret settings write to core.json.
 * API keys and secrets write to the OS credential store.
 */

// ─── Schema ──────────────────────────────────────────────────────────

import { config } from "../config.js";
import { resolveMakerBaseUrl } from "../providers/vertex_auth.js";

export const CONFIG_SCHEMA_VERSION = 1;

export interface ConfigSchema {
  schema_version: number;
  model: ModelConfig;
  approvals: ApprovalsConfig;
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

export interface ApprovalsConfig {
  require_approval_for: string[];
  auto_approve_safe: boolean;
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
      provider: "custom",
      model_name: config.llmModelName,
      base_url: resolveMakerBaseUrl() || config.llmBaseUrl,
      api_key_ref: "LLM_API_KEY",
      max_context_tokens: config.maxContextTokens,
      max_output_tokens: 16384,
      temperature: 0.7,
    },
    approvals: {
      require_approval_for: ["write_file", "replace_content", "run_command", "apply_patch"],
      auto_approve_safe: true,
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
    // base_url (local endpoint) is optional — cloud inference goes through
    // OpenRouter (OPENROUTER_API_KEY + OPENROUTER_MODEL_PROFILE).
    if (
      typeof config.model.max_context_tokens !== "number" ||
      config.model.max_context_tokens <= 0
    ) {
      errors.push("model.max_context_tokens must be a positive number");
    }
  }

  if (!config.approvals) {
    errors.push("Missing approvals config section");
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
    approvals: { ...defaults.approvals, ...config.approvals },
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
        {
          key: "provider",
          label: "Provider",
          type: "select",
          options: ["custom", "openrouter", "openai"],
        },
        { key: "model_name", label: "Model Name", type: "text" },
        { key: "base_url", label: "Base URL", type: "text" },
        { key: "api_key_ref", label: "API Key", type: "secret" },
        { key: "max_context_tokens", label: "Max Context Tokens", type: "number" },
        { key: "max_output_tokens", label: "Max Output Tokens", type: "number" },
        { key: "temperature", label: "Temperature", type: "number" },
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
