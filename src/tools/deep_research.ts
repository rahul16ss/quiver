import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

const PARALLEL_BASE = "https://api.parallel.ai";

/**
 * Parallel Task API — deep research.
 * POST /v1/tasks/runs to create, then GET /v1/tasks/runs/{run_id}/result (blocking with timeout) to retrieve.
 * For "pro" processor (~10 min), blocking with polling is appropriate.
 * For "ultra"/"ultra8x" (up to 2hr), we poll with retries up to 12 times.
 */

const VALID_PROCESSORS = [
  "lite",
  "base",
  "core",
  "core2x",
  "pro",
  "pro-fast",
  "ultra",
  "ultra-fast",
  "ultra2x",
  "ultra4x",
  "ultra8x",
] as const;

export const tool: Tool = {
  name: "deep_research",
  description:
    "Runs deep multi-hop web research via the Parallel Task API. Takes a natural-language research question and returns a comprehensive, cited answer. " +
    "Use when a single web_search isn't enough — questions requiring synthesis across many sources, multi-step reasoning, or structured data enrichment. " +
    "Processors: 'lite' (fastest, ~2 fields), 'base' (~5 fields), 'core' (~10 fields), 'pro' (default, ~20 fields, exploratory, ~10 min), 'ultra' (deep research, up to 2hr). " +
    "Scaled variants: 'core2x', 'pro-fast', 'ultra-fast', 'ultra2x', 'ultra4x', 'ultra8x'. " +
    "Defaults to 'pro' for best quality within a reasonable timeframe. Use 'core' or 'base' for faster results.",
  parameters: z.object({
    input: z
      .string()
      .describe(
        "The research question or task in natural language. Can be a plain question or a JSON-stringified object with structured context (e.g. company name + website).",
      ),
    processor: z
      .enum(VALID_PROCESSORS)
      .optional()
      .describe(
        "Processor tier: lite (fastest), base, core, pro (default, ~10 min), ultra (up to 2hr). Use lower tiers for simpler queries.",
      ),
    output_schema: z
      .string()
      .optional()
      .describe(
        'Optional JSON schema (as a JSON string) describing the desired structured output. If omitted, the API auto-generates a schema. Example: {"type":"object","properties":{"answer":{"type":"string"}},"required":["answer"]}',
      ),
  }),
  execute: async ({ input, processor, output_schema }) => {
    const apiKey = config.parallelApiKey;
    if (!apiKey) {
      return "Error: PARALLEL_API_KEY is not set in the configuration (.env). Deep research requires a Parallel.ai API key.";
    }

    const selectedProcessor = processor || "pro";

    // Build request body
    const body: any = {
      input,
      processor: selectedProcessor,
    };

    if (output_schema) {
      try {
        const parsed = JSON.parse(output_schema);
        body.task_spec = {
          output_schema: {
            type: "json",
            json_schema: parsed,
          },
        };
      } catch {
        // If it's not JSON, treat as a text schema description
        body.task_spec = {
          output_schema: {
            type: "text",
            description: output_schema,
          },
        };
      }
    }

    try {
      // Step 1: Create the task run
      const createResponse = await fetch(`${PARALLEL_BASE}/v1/tasks/runs`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(30000),
      });

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        return `Error: Parallel Task API create failed with status ${createResponse.status}: ${errorText}`;
      }

      const createData: any = await createResponse.json();
      const runId = createData.run_id;

      if (!runId) {
        return `Error: Parallel Task API did not return a run_id. Response: ${JSON.stringify(createData)}`;
      }

      // Step 2: Poll for results using the blocking result endpoint with timeout
      // The GET /v1/tasks/runs/{run_id}/result endpoint blocks until completion or timeout.
      // We use timeout=600 (10 min) per request and retry up to 12 times (2hr max for ultra).
      const maxPollAttempts = selectedProcessor.startsWith("ultra") ? 12 : 6;
      const timeoutPerRequest = 600; // 10 minutes per blocking request

      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        const resultResponse = await fetch(
          `${PARALLEL_BASE}/v1/tasks/runs/${runId}/result?timeout=${timeoutPerRequest}`,
          {
            method: "GET",
            headers: {
              "x-api-key": apiKey,
            },
            signal: AbortSignal.timeout((timeoutPerRequest + 30) * 1000),
          },
        );

        if (resultResponse.status === 200) {
          const resultData: any = await resultResponse.json();
          return formatTaskResult(resultData);
        }

        if (resultResponse.status === 408) {
          // Timeout — run still active, keep polling
          continue;
        }

        if (resultResponse.status === 404) {
          return `Error: Task run ${runId} failed or was not found.`;
        }

        // Other errors
        const errorText = await resultResponse.text();
        return `Error: Parallel Task API result fetch failed with status ${resultResponse.status}: ${errorText}`;
      }

      return `Error: Task run ${runId} did not complete within the polling budget (${maxPollAttempts * timeoutPerRequest} seconds). The run may still be active on Parallel's servers. Run ID: ${runId}`;
    } catch (error: any) {
      return `Error performing deep research: ${error.message}`;
    }
  },
};

function formatTaskResult(data: any): string {
  const run = data.run;
  const output = data.output;

  if (!output) {
    return `Task completed but returned no output. Run status: ${run?.status || "unknown"}`;
  }

  const lines: string[] = [];

  // Content
  if (output.type === "json") {
    lines.push("## Research Result\n");
    lines.push("```json");
    lines.push(JSON.stringify(output.content, null, 2));
    lines.push("```");
  } else {
    lines.push("## Research Result\n");
    lines.push(output.content || "(no content)");
  }

  // Basis (citations + reasoning)
  if (output.basis && Array.isArray(output.basis) && output.basis.length > 0) {
    lines.push("\n## Citations & Reasoning\n");
    for (const field of output.basis) {
      lines.push(`### ${field.field}`);
      if (field.confidence) {
        lines.push(`Confidence: ${field.confidence}`);
      }
      if (field.reasoning) {
        lines.push(`Reasoning: ${field.reasoning}`);
      }
      if (field.citations && Array.isArray(field.citations)) {
        for (const cite of field.citations) {
          lines.push(`  - [${cite.title || cite.url}](${cite.url})`);
          if (cite.excerpts && Array.isArray(cite.excerpts)) {
            for (const excerpt of cite.excerpts) {
              lines.push(`    > ${excerpt}`);
            }
          }
        }
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}
