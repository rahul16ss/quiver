/**
 * ModalityRouter behavioral tests (§5 router).
 *
 * Proves the pure routing function: (messages, role, sensitivity) → profileSlug.
 * No network, no transport. Deterministic exit.
 */
import picocolors from "picocolors";
import { ModelProfileRegistry, starterCatalog, applyApprovedModels } from "../../src/harness/model-profile.js";
import { ModalityRouter, classifyModality, AUTO_PROFILE, type ModelRole } from "../../src/harness/model-router.js";
import type { ModelMessage } from "../../src/harness/interfaces.js";

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, ok: boolean) {
  if (ok) { passed++; return; }
  failed++; failures.push(name);
  console.log(picocolors.red(`  ✗ FAIL  ${name}`));
}

function buildRouter(): { router: ModalityRouter; profiles: ModelProfileRegistry } {
  const profiles = new ModelProfileRegistry();
  for (const p of starterCatalog()) profiles.register(p);
  return { router: new ModalityRouter(profiles.list()), profiles };
}

const textMsg: ModelMessage = { role: "user", content: "Summarize the thesis." };
const pdfMsg: ModelMessage = {
  role: "user",
  content: [
    { type: "text", text: "read this prospectus" },
    { type: "file", mimeType: "application/pdf", data: Buffer.from("%PDF-1.4"), filename: "p.pdf" },
  ],
};
const docxMsg: ModelMessage = {
  role: "user",
  content: [
    { type: "text", text: "analyze" },
    { type: "file", mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", data: Buffer.from([0x50, 0x4b]) },
  ],
};
const pngMsg: ModelMessage = {
  role: "user",
  content: [{ type: "image", mimeType: "image/png", data: Buffer.from([0x89, 0x50]) }],
};

function run() {
  const { router, profiles } = buildRouter();

  // ── classifyModality ───────────────────────────────────────────────
  check("MODALITY-TEXT", classifyModality([textMsg]) === "text-only");
  check("MODALITY-PDF", classifyModality([pdfMsg]) === "native-file");
  check("MODALITY-DOCX", classifyModality([docxMsg]) === "native-file");
  check("MODALITY-PNG", classifyModality([pngMsg]) === "native-file");
  check("MODALITY-MIXED-PREFERS-NATIVE", classifyModality([textMsg, pdfMsg]) === "native-file");

  // ── Text-only routing by role ─────────────────────────────────────
  // Maker + planner → text-maker (deepseek-v4-flash). Checker → text-checker
  // (glm-5.2, independent family). Reviewer/failsafe → text-failsafe (gpt-5.6-sol).
  check("TEXT-MAKER", router.route([textMsg], "maker", "public") === "text-maker");
  check("TEXT-PLANNER-IS-MAKER", router.route([textMsg], "planner", "public") === "text-maker");
  check("TEXT-CHECKER-IS-GLM", router.route([textMsg], "checker", "public") === "text-checker");
  check("TEXT-REVIEWER-IS-FAILSAFE", router.route([textMsg], "reviewer", "public") === "text-failsafe");
  check("TEXT-FAILSAFE", router.route([textMsg], "failsafe", "public") === "text-failsafe");

  // ── Native-file routing never falls back to a text profile ─────────
  // Maker/checker with a file → native-doc-primary (sonnet-5).
  // Reviewer/failsafe with a file → native-doc-frontier (opus-5).
  check("NATIVE-MAKER-IS-SONNET", router.route([pdfMsg], "maker", "public") === "native-doc-primary");
  check("NATIVE-CHECKER-IS-SONNET", router.route([pdfMsg], "checker", "public") === "native-doc-primary");
  check("NATIVE-REVIEWER-IS-OPUS", router.route([pdfMsg], "reviewer", "public") === "native-doc-frontier");
  check("NATIVE-FAILSAFE-IS-OPUS", router.route([pdfMsg], "failsafe", "public") === "native-doc-frontier");
  check("NATIVE-DOCX-ROUTES-NATIVE", router.route([docxMsg], "maker", "public") === "native-doc-primary");
  check("NATIVE-PNG-ROUTES-NATIVE", router.route([pngMsg], "maker", "public") === "native-doc-primary");

  // ── MNPI never egresses to cloud, regardless of modality ──────────
  check("MNPI-TEXT-TO-LOCAL", router.route([textMsg], "maker", "restricted-mnpi") === "local-private-default");
  check("MNPI-PDF-TO-LOCAL", router.route([pdfMsg], "maker", "restricted-mnpi") === "local-private-default");
  check("MNPI-CHECKER-TO-LOCAL", router.route([textMsg], "checker", "restricted-mnpi") === "local-private-default");

  // ── Confidential-internal uses cloud tiers (not local) ────────────
  check("CONFIDENTIAL-TEXT-MAKER", router.route([textMsg], "maker", "confidential-internal") === "text-maker");
  check("CONFIDENTIAL-NATIVE-MAKER", router.route([pdfMsg], "maker", "confidential-internal") === "native-doc-primary");

  // ── Maker/checker family separation (independent failure modes) ──
  const makerModel = profiles.get(router.route([textMsg], "maker", "public")!)!.modelSlug;
  const checkerModel = profiles.get(router.route([textMsg], "checker", "public")!)!.modelSlug;
  check("MAKER-CHECKER-DIFFERENT-FAMILY", makerModel !== checkerModel);
  check("MAKER-IS-DEEPSEEK", makerModel === "deepseek/deepseek-v4-flash-0731");
  check("CHECKER-IS-GLM", checkerModel === "z-ai/glm-5.2");

  // ── Native-doc profiles are file-capable; text profiles are not ───
  const nativeMaker = profiles.get(router.route([pdfMsg], "maker", "public")!)!;
  const textMaker = profiles.get(router.route([textMsg], "maker", "public")!)!;
  check("NATIVE-PROFILE-ACCEPTS-FILE", nativeMaker.nativeFileInput === true);
  check("TEXT-PROFILE-REJECTS-FILE", textMaker.nativeFileInput === false);

  // ── Fallback within tier when preferred profile is missing ────────
  const partial = new ModelProfileRegistry();
  // Register only the budget native-doc + text-pro (neither is the preferred
  // pick for maker). Router must fall back WITHIN the tier, never cross to OCR.
  for (const p of starterCatalog()) {
    if (p.slug === "native-doc-budget" || p.slug === "text-pro") partial.register(p);
  }
  const partialRouter = new ModalityRouter(partial.list());
  check("NATIVE-FALLBACK-WITHIN-TIER", partialRouter.route([pdfMsg], "maker", "public") === "native-doc-budget");
  check("TEXT-FALLBACK-WITHIN-TIER", partialRouter.route([textMsg], "maker", "public") === "text-pro");

  // ── No eligible profile → undefined (caller must fail closed) ────
  const empty = new ModelProfileRegistry();
  const emptyRouter = new ModalityRouter(empty.list());
  check("EMPTY-RETURNS-UNDEFINED-TEXT", emptyRouter.route([textMsg], "maker", "public") === undefined);
  check("EMPTY-RETURNS-UNDEFINED-NATIVE", emptyRouter.route([pdfMsg], "maker", "public") === undefined);
  check("EMPTY-RETURNS-UNDEFINED-MNPI", emptyRouter.route([textMsg], "maker", "restricted-mnpi") === undefined);

  // ── AUTO sentinel is the documented trigger ───────────────────────
  check("AUTO-SENTINEL-IS-AUTO", AUTO_PROFILE === "auto");

  // ── A native-file message with only text profiles available → undefined
  //    (must NOT silently route to a text profile + OCR) ──────────────
  const textOnly = new ModelProfileRegistry();
  for (const p of starterCatalog()) if (!p.nativeFileInput || p.slug === "local-private-default") {
    if (p.slug !== "local-private-default" && !p.nativeFileInput) textOnly.register(p);
  }
  // register only text-only profiles (no native-doc, no local)
  const textOnlyRouter = new ModalityRouter(
    starterCatalog().filter((p) => !p.nativeFileInput && p.slug !== "local-private-default"),
  );
  check("NATIVE-WITH-NO-FILE-PROFILE-UNDEFINED", textOnlyRouter.route([pdfMsg], "maker", "public") === undefined);

  // ── Customer pack approvedModels DRIVE routing (fail closed) ─────────
  const base = new ModelProfileRegistry();
  for (const p of starterCatalog()) base.register(p);
  // A pack approving ONLY the text-maker (for maker) + a native-doc profile
  // must restrict routing: unapproved profiles are unreachable.
  const packRestricted = applyApprovedModels(base, [
    { profileSlug: "text-maker", roles: ["maker"], providerOrder: ["DeepSeek"] },
    { profileSlug: "native-doc-primary", roles: ["maker", "checker"], providerOrder: ["Anthropic"] },
  ]);
  const packRouter = new ModalityRouter(packRestricted.list());
  // Precompute route results once (avoids nested-call inference + is clearer).
  const tMaker = packRouter.route([textMsg], "maker", "public");
  const nMaker = packRouter.route([pdfMsg], "maker", "public");
  const reviewer = packRouter.route([textMsg], "reviewer", "public");
  const failsafe = packRouter.route([textMsg], "failsafe", "public");
  // Text maker routes to the pack-approved text-maker.
  check("PACK-TEXT-MAKER-ROUTES-APPROVED", tMaker === "text-maker");
  // Native-file maker routes to pack-approved native-doc (NOT unapproved frontier).
  check("PACK-NATIVE-ROUTES-APPROVED", nMaker === "native-doc-primary");
  // text-failsafe is NOT approved: reviewer/failsafe fail CLOSED to approved
  // text-maker rather than reaching an unapproved profile.
  check("PACK-FAILSAFE-CLOSED-TO-APPROVED", reviewer === "text-maker");
  check("PACK-CANNOT-REACH-UNAPPROVED", failsafe === "text-maker");
  // A pack approving ONLY a native-doc profile leaves text maker undefined
  // (no text profile approved → fail closed, never a silent unapproved pick).
  const nativeOnly = applyApprovedModels(base, [{ profileSlug: "native-doc-primary", roles: ["maker"], providerOrder: ["Anthropic"] }]);
  const nativeOnlyRouter = new ModalityRouter(nativeOnly.list());
  const noText = nativeOnlyRouter.route([textMsg], "maker", "public");
  check("PACK-NATIVE-ONLY-TEXT-UNDEF", noText === undefined);
  // Pack providerOrder is applied to the approved profile.
  check("PACK-PROVIDER-ORDER-APPLIED", packRestricted.get("native-doc-primary")?.providerOrder.join(",") === "Anthropic");
}

run();
if (failed > 0) {
  console.log(picocolors.red(`\n❌ ${failed} router check(s) FAILED:\n${failures.join("\n")}`));
  process.exit(1);
}
console.log(picocolors.cyan(`\n  ✔ ${passed} router checks passed.`));
