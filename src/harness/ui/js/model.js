import { $ } from "./dom.js";
import { state } from "./state.js";

const MODEL_LABELS = [
  // (registry prefix or substring, friendly label)
  ["gpt-oss", "GPT-OSS"],
  ["glm-5", "GLM 5.2"],
  ["glm-4", "GLM 4"],
  ["gemma3", "Gemma 3"],
  ["gemma2", "Gemma 2"],
  ["llama3.3", "Llama 3.3"],
  ["llama3.2", "Llama 3.2"],
  ["llama3.1", "Llama 3.1"],
  ["llama3", "Llama 3"],
  ["qwen3.5", "Qwen 3.5"],
  ["qwen3", "Qwen 3"],
  ["qwen2.5", "Qwen 2.5"],
  ["qwen2", "Qwen 2"],
  ["deepseek-r1", "DeepSeek R1"],
  ["deepseek", "DeepSeek"],
  ["phi3", "Phi-3"],
  ["mistral-large", "Mistral Large"],
  ["mistral", "Mistral"],
  ["mixtral", "Mixtral"],
  ["codellama", "Code Llama"],
  ["codestral", "Codestral"],
  ["command-r", "Command R"],
];
// Size tags we lift into a quiet suffix (e.g. Gemma 3 · 4B / Qwen 3.5 · 397B).
const SIZE_TAG = /:(\d+(?:\.\d+)?b|\d+x\d+b)/i;
function friendlyModelName(id) {
  const raw = String(id || "").trim();
  if (!raw) return "—";
  // strip registry host (e.g. "registry.example/gemma3") and any :tag
  const base = raw.split("/").pop().split(":")[0];
  const tag = (SIZE_TAG.exec(raw) || [])[1];
  const key = base.toLowerCase();
  let label = null;
  for (const [needle, name] of MODEL_LABELS) {
    if (key.includes(needle)) {
      label = name;
      break;
    }
  }
  if (!label) {
    // graceful fallback: turn "some-model_name" into "Some Model Name"
    label = base.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (tag) label += ` \u00b7 ${tag.toUpperCase()}`; // middot, Apple-style
  return label;
}
function modelLocality(config) {
  const baseUrl = config?.provider?.baseUrl || "";
  try {
    const host = new URL(baseUrl).hostname;
    if (host === "localhost" || host === "127.0.0.1") return "Local";
    if (host) return "Cloud";
  } catch {}
  return "";
}
function setModel(name, config) {
  if (config) state.lastModelConfig = config;
  const cfg = config || state.lastModelConfig;
  const f = friendlyModelName(name);
  const locality = modelLocality(cfg);
  // The Electron shell had a #modelBadge in the top bar; the browser UI
  // surfaces the model in the context plane (trust pill covers the top bar).
  const badge = $("modelBadge");
  if (badge) {
    badge.textContent = locality ? `Model \u00b7 ${f} \u00b7 ${locality}` : `Model \u00b7 ${f}`;
    badge.title = name ? `Model id: ${name}` : "No model selected";
  }
  const ctxModel = $("ctxModel");
  if (ctxModel) {
    ctxModel.textContent = f;
    ctxModel.title = name ? name : "";
  }
}

export { MODEL_LABELS, SIZE_TAG, friendlyModelName, modelLocality, setModel };
