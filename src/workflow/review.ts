/**
 * Multi-Role Review System — document approval workflow.
 *
 * Tracks review decisions per document through a configurable chain
 * (analyst → VP → IC/Partner), records comments, approvals, rejections.
 * Stores state in `.quiver/reviews/`. Integrates with the audit chain.
 *
 * The review chain is the human-in-the-loop gate that ensures no
 * AI-generated document reaches a client without proper sign-off.
 *
 * SPEC §5 / §12 / §19.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import type { ReviewRole, ReviewDecision, DocumentReview } from "./types.js";

// ─── Persistence ───────────────────────────────────────────────────────

function reviewsDir(): string {
  return path.join(os.homedir(), ".quiver", "reviews");
}

function reviewPath(runId: string): string {
  return path.join(reviewsDir(), `${runId}.json`);
}

function ensureReviewsDir(): void {
  fs.mkdirSync(reviewsDir(), { recursive: true });
}

function saveReview(review: DocumentReview): void {
  ensureReviewsDir();
  fs.writeFileSync(reviewPath(review.run_id), JSON.stringify(review, null, 2));
}

function loadReview(runId: string): DocumentReview | null {
  const p = reviewPath(runId);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

// ─── Default review chains by family ──────────────────────────────────

const DEFAULT_REVIEW_CHAINS: Record<string, ReviewRole[]> = {
  dealmaking: ["analyst", "vp", "partner"],
  research: ["analyst", "senior_analyst", "pm"],
  wealth: ["analyst", "advisor", "cio"],
};

// ─── Review Manager ───────────────────────────────────────────────────

export class ReviewManager {
  /**
   * Create a new document review.
   */
  createReview(
    document: string,
    runId: string,
    family: string,
    customChain?: ReviewRole[],
  ): DocumentReview {
    const chain = customChain || DEFAULT_REVIEW_CHAINS[family] || ["analyst"];

    const review: DocumentReview = {
      document,
      run_id: runId,
      stage: chain[0],
      required_reviewers: chain,
      decisions: [],
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    saveReview(review);
    return review;
  }

  /**
   * Submit a review decision.
   */
  submitDecision(
    runId: string,
    role: ReviewRole,
    reviewer: string,
    decision: "approved" | "rejected" | "commented",
    comment?: string,
  ): DocumentReview | null {
    const review = loadReview(runId);
    if (!review) return null;

    // Verify this role is the current stage
    if (role !== review.stage) {
      throw new Error(`Cannot submit decision: current stage is "${review.stage}", not "${role}"`);
    }

    const decisionRecord: ReviewDecision = {
      role,
      reviewer,
      decision,
      comment,
      timestamp: new Date().toISOString(),
    };

    review.decisions.push(decisionRecord);
    review.updated_at = new Date().toISOString();

    if (decision === "rejected") {
      review.status = "rejected";
    } else if (decision === "approved") {
      // Move to next stage
      const currentIdx = review.required_reviewers.indexOf(role);
      if (currentIdx >= 0 && currentIdx < review.required_reviewers.length - 1) {
        review.stage = review.required_reviewers[currentIdx + 1];
        review.status = "in_review";
      } else {
        // Final approval
        review.status = "approved";
      }
    }
    // "commented" doesn't change the stage

    saveReview(review);
    return review;
  }

  /**
   * Get the current review state for a run.
   */
  getReview(runId: string): DocumentReview | null {
    return loadReview(runId);
  }

  /**
   * List all reviews, optionally filtered by status.
   */
  listReviews(status?: DocumentReview["status"]): DocumentReview[] {
    const dir = reviewsDir();
    if (!fs.existsSync(dir)) return [];

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    const reviews: DocumentReview[] = [];

    for (const file of files) {
      try {
        const review = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8")) as DocumentReview;
        if (!status || review.status === status) {
          reviews.push(review);
        }
      } catch {
        // Skip corrupted review files
      }
    }

    return reviews.sort(
      (a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime(),
    );
  }

  /**
   * Get a summary of the review chain for display.
   */
  formatReviewStatus(review: DocumentReview): string {
    const lines: string[] = [];
    lines.push(`Document: ${review.document}`);
    lines.push(`Status: ${review.status.toUpperCase()}`);
    lines.push(`Run: ${review.run_id}`);
    lines.push("");

    lines.push("Review chain:");
    for (const role of review.required_reviewers) {
      const decision = review.decisions.find((d) => d.role === role);
      if (decision) {
        const mark =
          decision.decision === "approved" ? "✓" : decision.decision === "rejected" ? "✗" : "…";
        const detail = decision.comment ? ` — "${decision.comment}"` : "";
        lines.push(`  ${mark} ${role}: ${decision.decision} by ${decision.reviewer}${detail}`);
      } else if (role === review.stage) {
        lines.push(`  → ${role}: AWAITING REVIEW`);
      } else {
        lines.push(`  ○ ${role}: pending`);
      }
    }

    return lines.join("\n");
  }
}

// ─── Singleton ────────────────────────────────────────────────────────

export const reviewManager = new ReviewManager();
