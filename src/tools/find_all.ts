import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

const PARALLEL_BASE = "https://api.parallel.ai";

/**
 * Parallel FindAll API — discover and verify entities matching natural-language criteria.
 * POST /v1beta/findall/runs to create, then poll GET /v1beta/findall/runs/{findall_id} until
 * status.is_active is false, then GET /v1beta/findall/runs/{findall_id}/result for results.
 */

const VALID_GENERATORS = ["preview", "base", "core", "pro"] as const;

export const tool: Tool = {
  name: "find_all",
  description:
    "Discovers and verifies entities (companies, people) matching natural-language criteria via the Parallel FindAll API. " +
    "Describe what you're looking for in plain language; it searches the web, evaluates candidates against match conditions, and returns verified matches with citations. " +
    "Use for lead gen, competitive mapping, dataset building. If you already have a list and need to enrich it, use deep_research instead. " +
    "Generators: 'preview' (test, ~10 candidates, low cost), 'base' (broad matches), 'core' (specific), 'pro' (rare/hard-to-find, most thorough).",
  parameters: z.object({
    objective: z
      .string()
      .describe(
        "Natural-language description of the entities to find. E.g. 'Find all AI startups that raised Series A in 2024'.",
      ),
    entity_type: z
      .enum(["companies", "people"])
      .describe("Type of entity to search for."),
    match_conditions: z
      .array(
        z.object({
          name: z
            .string()
            .describe("Short name for the match condition (snake_case)."),
          description: z
            .string()
            .describe(
              "Detailed description of the match condition. Include specific criteria to improve accuracy. E.g. 'Company must have announced a Series A funding round between 2024-01-01 and 2024-12-31.'",
            ),
        }),
      )
      .min(1)
      .describe(
        "List of match conditions. Each candidate is evaluated against all conditions. A candidate matches only if all conditions are satisfied.",
      ),
    generator: z
      .enum(VALID_GENERATORS)
      .optional()
      .describe(
        "Generator tier: preview (test, ~10 candidates), base (broad), core (specific), pro (thorough). Defaults to 'base'.",
      ),
    match_limit: z
      .number()
      .int()
      .min(5)
      .max(1000)
      .optional()
      .describe(
        "Maximum number of matches to find (5-1000). May return fewer. Defaults to 20.",
      ),
  }),
  execute: async ({
    objective,
    entity_type,
    match_conditions,
    generator,
    match_limit,
  }) => {
    const apiKey = config.parallelApiKey;
    if (!apiKey) {
      return "Error: PARALLEL_API_KEY is not set in the configuration (.env). FindAll requires a Parallel.ai API key.";
    }

    const selectedGenerator = generator || "base";
    const selectedLimit = match_limit || 20;

    try {
      // Step 1: Create the FindAll run
      const createResponse = await fetch(
        `${PARALLEL_BASE}/v1beta/findall/runs`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            objective,
            entity_type,
            match_conditions,
            generator: selectedGenerator,
            match_limit: selectedLimit,
          }),
          signal: AbortSignal.timeout(30000),
        },
      );

      if (!createResponse.ok) {
        const errorText = await createResponse.text();
        return `Error: Parallel FindAll create failed with status ${createResponse.status}: ${errorText}`;
      }

      const createData: any = await createResponse.json();
      const findallId = createData.findall_id;

      if (!findallId) {
        return `Error: Parallel FindAll did not return a findall_id. Response: ${JSON.stringify(createData)}`;
      }

      // Step 2: Poll until the run is no longer active
      const maxPollAttempts = 120; // 10 min max at 5s intervals
      const pollIntervalMs = 5000;
      let runCompleted = false;

      for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
        if (attempt > 0) {
          await sleep(pollIntervalMs);
        }

        const statusResponse = await fetch(
          `${PARALLEL_BASE}/v1beta/findall/runs/${findallId}`,
          {
            method: "GET",
            headers: {
              "x-api-key": apiKey,
            },
            signal: AbortSignal.timeout(15000),
          },
        );

        if (!statusResponse.ok) {
          const errorText = await statusResponse.text();
          return `Error: Parallel FindAll status check failed with status ${statusResponse.status}: ${errorText}`;
        }

        const statusData: any = await statusResponse.json();
        const isActive = statusData.status?.is_active;
        const runStatus = statusData.status?.status;

        if (!isActive) {
          if (runStatus === "failed") {
            const errorMsg = statusData.status?.error?.message || "Run failed";
            return `Error: Parallel FindAll run failed: ${errorMsg}`;
          }
          runCompleted = true;
          break;
        }
      }

      if (!runCompleted) {
        return `Error: FindAll run ${findallId} did not complete within the polling budget (${(maxPollAttempts * pollIntervalMs) / 1000} seconds). The run may still be active on Parallel's servers. FindAll ID: ${findallId}`;
      }

      // Step 3: Fetch results
      const resultResponse = await fetch(
        `${PARALLEL_BASE}/v1beta/findall/runs/${findallId}/result`,
        {
          method: "GET",
          headers: {
            "x-api-key": apiKey,
          },
          signal: AbortSignal.timeout(30000),
        },
      );

      if (!resultResponse.ok) {
        const errorText = await resultResponse.text();
        return `Error: Parallel FindAll result fetch failed with status ${resultResponse.status}: ${errorText}`;
      }

      const resultData: any = await resultResponse.json();
      return formatFindAllResult(resultData);
    } catch (error: any) {
      return `Error performing FindAll: ${error.message}`;
    }
  },
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatFindAllResult(data: any): string {
  const run = data.run;
  const candidates = data.candidates || [];
  const status = run?.status;

  const lines: string[] = [];

  lines.push("## FindAll Results\n");
  lines.push(`Status: ${status?.status || "unknown"}`);
  lines.push(
    `Generated: ${status?.metrics?.generated_candidates_count || 0} candidates | Matched: ${status?.metrics?.matched_candidates_count || 0}`,
  );

  if (status?.termination_reason) {
    lines.push(`Termination: ${status.termination_reason}`);
  }
  lines.push("");

  const matched = candidates.filter((c: any) => c.match_status === "matched");
  const unmatched = candidates.filter(
    (c: any) => c.match_status === "unmatched",
  );

  if (matched.length > 0) {
    lines.push(`### Matched Entities (${matched.length})\n`);
    for (const c of matched) {
      lines.push(`**${c.name}** — ${c.url}`);
      if (c.description) {
        lines.push(`  ${c.description}`);
      }
      if (c.output) {
        lines.push(`  Conditions: ${JSON.stringify(c.output)}`);
      }
      if (c.basis && Array.isArray(c.basis) && c.basis.length > 0) {
        for (const field of c.basis) {
          if (field.citations && Array.isArray(field.citations)) {
            for (const cite of field.citations) {
              lines.push(`  - [${cite.title || cite.url}](${cite.url})`);
            }
          }
        }
      }
      lines.push("");
    }
  }

  if (unmatched.length > 0 && unmatched.length <= 20) {
    lines.push(`### Unmatched Entities (${unmatched.length})\n`);
    for (const c of unmatched) {
      lines.push(`- ${c.name} — ${c.url} (${c.match_status})`);
    }
    lines.push("");
  } else if (unmatched.length > 20) {
    lines.push(`### Unmatched Entities: ${unmatched.length} (not shown)\n`);
  }

  return lines.join("\n");
}
