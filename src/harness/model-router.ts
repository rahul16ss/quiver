/**
 * ModalityRouter — ADR-001 §5 (native-document vs text-only routing).
 *
 * Selects a ModelProfile slug per invocation based on:
 *   1. message modality — does the message carry a native file content part
 *      (PDF/DOCX/XLSX/PPTX/image)? If so, the model's `input_modalities` MUST
 *      include `file` so OpenRouter forwards the bytes directly to the model
 *      — no third-party OCR cloud (Mistral) ever touches the document. This is
 *      a hard security requirement for MNPI capital-markets data.
 *   2. role — maker / checker / planner / reviewer / failsafe. Maker and
 *      checker are deliberately different model families so the checker is an
 *      independent failure mode, not the same weights auditing themselves.
 *   3. sensitivity — restricted-mnpi must route to a local route, never cloud.
 *
 * Routing is a pure function of (messages, role, sensitivity) → profileSlug.
 * The selected profile is still subject to the CapabilityRegistry's
 * per-MIME certification gate in QuiverOpenRouterClient.invoke — the router
 * proposes, certification disposes. Fail closed, never silently substitute OCR.
 *
 * Selection (ZDR endpoints, live OpenRouter data Aug 2026 — see
 * docs/refactor/model-router.md; FAB v2 / CorpFin v2 / EMB benchmarks):
 *   native-doc-frontier : anthropic/claude-opus-5   $5/$25  (reviewer/failsafe)
 *   native-doc-primary  : anthropic/claude-sonnet-5  $2/$10  (native-doc maker)
 *   native-doc-checker  : moonshotai/kimi-k3         $3/$15  (native-doc checker — Moonshot ≠ Anthropic)
 *   native-doc-budget   : google/gemini-3.6-flash    $1.5/$7.5 (budget)
 *   text-planner        : openai/gpt-5.6-sol         $5/$30  (planner, both tiers)
 *   text-failsafe       : openai/gpt-5.6-sol         $5/$30  (failsafe)
 *   text-checker        : google/gemini-3.5-flash    $1.5/$9 (text checker — Google ≠ OpenAI)
 *   text-maker          : openai/gpt-5.6-luna        $0.10/$0.60 (text maker)
 *   text-pro            : deepseek/deepseek-v4-pro   $0.44/$0.87 (fallback)
 */

import type { ModelMessage, ContentPart, SensitivityProfile } from "./interfaces.js";
import type { ModelProfile } from "./model-profile.js";

/** The role a model call plays in the workflow. Drives family separation. */
export type ModelRole = "planner" | "maker" | "checker" | "reviewer" | "failsafe";

/** The auto-routing sentinel. `options.modelProfile === AUTO_PROFILE` invokes the router. */
export const AUTO_PROFILE = "auto";

/**
 * The modality a message presents to the router. `native-file` means at least
 * one content part is a file or image the model must ingest natively.
 */
export type MessageModality = "text-only" | "native-file";

/** MIME types that require a native-document-capable model. */
const NATIVE_FILE_MIMES = new Set<string>([
	"application/pdf",
	"application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	"application/vnd.openxmlformats-officedocument.presentationml.presentation",
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif",
]);

/** Inspect a message stream and return its modality (text-only vs native-file). */
export function classifyModality(messages: ModelMessage[]): MessageModality {
	for (const m of messages) {
		if (typeof m.content === "string") continue;
		for (const part of m.content) {
			if (part.type === "file" && NATIVE_FILE_MIMES.has(part.mimeType)) return "native-file";
			if (part.type === "image" && NATIVE_FILE_MIMES.has(part.mimeType)) return "native-file";
		}
	}
	return "text-only";
}

/** True when a MIME represents a native document deliverable needing a multimodal model. */
export function isNativeDocMime(mime: string): boolean {
	return NATIVE_FILE_MIMES.has(mime);
}

/**
 * The modality router. Constructed with the catalog of registered profiles
 * (already loaded into a ModelProfileRegistry); selects a slug per call.
 *
 * Pure and unit-testable: no network, no transport. The caller (the engine)
 * passes the selected slug to `ModelClient.invoke({ modelProfile })`.
 */
export class ModalityRouter {
	/** slug → profile (the live catalog; profiles carry certification state). */
	private bySlug = new Map<string, ModelProfile>();

	constructor(profiles: ModelProfile[]) {
		for (const p of profiles) this.bySlug.set(p.slug, p);
	}

	/**
	 * Pick a profile slug for a call. Returns `undefined` when no eligible
	 * profile exists (e.g. restricted-mnpi with no local route, or a native-file
	 * message with no file-capable profile). The caller must fail closed on
	 * `undefined` — never fall back to a text profile + OCR for a file message.
	 */
	route(
		messages: ModelMessage[],
		role: ModelRole,
		sensitivity: SensitivityProfile,
		hintMime?: string,
	): string | undefined {
		// 1. MNPI never egresses to cloud. Only a local/private route may serve it.
		if (sensitivity === "restricted-mnpi") {
			return this.bySlug.has("local-private-default") ? "local-private-default" : undefined;
		}

		const modality = classifyModality(messages);

		// 2. Native file → a profile whose model accepts file input natively.
		if (modality === "native-file") {
			return this.pickNativeDoc(role);
		}

		// 2b. A native-document deliverable (hintMime) also needs a native-doc
		// model — producing a docx/pdf/pptx calls for a multimodal-capable maker
		// even on a text-only prompt, so the deliverable benefits from native
		// document understanding. text/vnd mimes stay on the text tier.
		if (hintMime && isNativeDocMime(hintMime) && this.pickNativeDoc(role)) {
			return this.pickNativeDoc(role);
		}

		// 3. Text-only → the cheaper text tier.
		return this.pickText(role);
	}

	/** Whether a profile slug is registered (used to validate explicit overrides). */
	has(slug: string): boolean {
		return this.bySlug.has(slug);
	}

	// ─── native-document tier ──────────────────────────────────────────

	/** True when a registered profile may serve `role` (allowedRoles absent → any). */
	private servesRole(slug: string, role: ModelRole): boolean {
		const p = this.bySlug.get(slug);
		if (!p) return false;
		return !p.allowedRoles || p.allowedRoles.includes(role);
	}

	private pickNativeDoc(role: ModelRole): string | undefined {
		// Reviewer / failsafe get the frontier native-doc model (Opus 5 is
		// particularly strong at chart/document visual analysis + complex office
		// deliverables). The maker gets the value native-doc model (Sonnet 5).
		// The checker is a deliberately different family (Kimi K3, Moonshot) from
		// the maker (Sonnet 5, Anthropic) — an independent second pair of eyes.
		// The planner is Sol in every tier (plans from text digests).
		const preferred =
			role === "reviewer" || role === "failsafe"
				? "native-doc-frontier"
				: role === "checker"
					? "native-doc-checker"
					: role === "planner"
						? "text-planner"
						: "native-doc-primary";
		if (this.servesRole(preferred, role)) return preferred;
		// Fall back within the native-doc tier only — never to a text profile,
		// and never to a profile the pack disallows for this role. (The planner
		// falls back to the native-doc maker rather than fail closed.)
		const order =
			role === "checker"
				? ["native-doc-checker", "native-doc-primary", "native-doc-frontier", "native-doc-budget"]
				: role === "planner"
					? ["text-planner", "native-doc-primary", "native-doc-frontier"]
					: ["native-doc-frontier", "native-doc-primary", "native-doc-budget"];
		return order.find((s) => this.servesRole(s, role));
	}

	// ─── text-only tier ────────────────────────────────────────────────

	private pickText(role: ModelRole): string | undefined {
		// Checker is a deliberately independent family (Gemini, Google) from the
		// maker (Luna, OpenAI) so the checker is a genuine second pair of eyes.
		// The planner is Sol (OpenAI) — it decomposes; it never audits the maker.
		const preferred =
			role === "checker"
				? "text-checker"
				: role === "reviewer" || role === "failsafe"
					? "text-failsafe"
					: role === "planner"
						? "text-planner"
						: "text-maker"; // maker
		if (this.servesRole(preferred, role)) return preferred;
		const order = ["text-maker", "text-planner", "text-checker", "text-failsafe", "text-pro"];
		return order.find((s) => this.servesRole(s, role));
	}
}
