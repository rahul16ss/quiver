/**
 * ArtifactRepository — Phase 1 (ADR-005).
 *
 * Immutable source snapshots → isolated working copies → candidate output →
 * semantic/visual diff → evidence companion → approval state → committed
 * output identity. Never edits the original directly during generation.
 *
 * This is a local, filesystem-backed implementation suitable for unit tests and
 * as the default work-product store. A deployment can substitute a different
 * backend behind the same interface. It uses atomic writes and recoverable
 * backups and refuses to overwrite a source without an approved change set.
 */

import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import type {
  ArtifactRepository,
  StagedArtifact,
  CandidateArtifact,
  ArtifactDiff,
  ApprovalDecision,
  ApprovalState,
  CommittedArtifact,
  StorageIdentity,
} from "./interfaces.js";
import { atomicWriteSync, rollbackLast as rollbackLastWrite } from "../fs/atomic_write.js";

export class LocalArtifactRepository implements ArtifactRepository {
  constructor(private stagingRoot: string) {
    fs.mkdirSync(stagingRoot, { recursive: true });
  }

  private runDir(runId: string): string {
    return path.join(this.stagingRoot, runId);
  }

  stage(
    source: { identity: StorageIdentity; data: Buffer; mimeType: string; path?: string },
    runId: string,
  ): Promise<StagedArtifact> {
    const dir = this.runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    const sourceHash = sha256(source.data);
    const snapshotPath = path.join(dir, "source.snapshot" + extFor(source.mimeType));
    const workingCopyPath = path.join(dir, "working-copy" + extFor(source.mimeType));
    // Immutable snapshot — written once, never overwritten.
    if (!fs.existsSync(snapshotPath)) {
      atomicWriteSync(snapshotPath, source.data);
    }
    // Isolated working copy — the only thing generation may edit.
    atomicWriteSync(workingCopyPath, source.data);
    const staged: StagedArtifact = {
      runId,
      sourceIdentity: source.identity,
      sourceHash,
      sourceVersion: source.identity.id,
      snapshotPath,
      workingCopyPath,
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(dir, "staged.json"), JSON.stringify(staged, null, 2));
    return Promise.resolve(staged);
  }

  recordCandidate(
    staged: StagedArtifact,
    candidate: { path: string; data: Buffer; mimeType: string },
  ): Promise<CandidateArtifact> {
    const dir = this.runDir(staged.runId);
    const candidatePath = path.join(dir, "candidate" + extFor(candidate.mimeType));
    atomicWriteSync(candidatePath, candidate.data);
    const candidateHash = sha256(candidate.data);
    const rec: CandidateArtifact = {
      staged,
      candidatePath,
      candidateHash,
      mimeType: candidate.mimeType,
      approval: { status: "pending", decisions: [] },
    };
    fs.writeFileSync(path.join(dir, "candidate.json"), JSON.stringify(rec, null, 2));
    return Promise.resolve(rec);
  }

  attachEvidence(candidate: CandidateArtifact, evidence: Record<string, unknown>): Promise<void> {
    const dir = this.runDir(candidate.staged.runId);
    const evidencePath = path.join(dir, "evidence.json");
    atomicWriteSync(evidencePath, Buffer.from(JSON.stringify(evidence, null, 2)));
    candidate.evidenceRef = evidencePath;
    fs.writeFileSync(path.join(dir, "candidate.json"), JSON.stringify(candidate, null, 2));
    return Promise.resolve();
  }

  diff(staged: StagedArtifact, candidate: CandidateArtifact): Promise<ArtifactDiff> {
    const before = safeRead(staged.snapshotPath);
    const after = safeRead(candidate.candidatePath);
    const changes: ArtifactDiff["changes"] = [];
    // A coarse structural diff: line-level for text-ish artifacts. Office-aware
    // semantic diff is delegated to the OfficeEngine in Phase 6; this base
    // implementation is honest about being structural only.
    const beforeLines = before.split("\n");
    const afterLines = after.split("\n");
    const max = Math.max(beforeLines.length, afterLines.length);
    for (let i = 0; i < max; i++) {
      const b = beforeLines[i] ?? "";
      const a = afterLines[i] ?? "";
      if (b !== a) {
        changes.push({
          kind: "paragraph",
          locator: `line:${i + 1}`,
          before: b || undefined,
          after: a || undefined,
        });
      }
    }
    return Promise.resolve({
      semantic:
        changes.length === 0 ? "no structural changes" : `${changes.length} structural change(s)`,
      changes,
    });
  }

  setApproval(candidate: CandidateArtifact, decision: ApprovalDecision): Promise<void> {
    const state: ApprovalState = candidate.approval;
    state.decisions.push(decision);
    if (decision.overall === "accepted") state.status = "accepted";
    else if (decision.overall === "rejected") state.status = "rejected";
    else state.status = "partial";
    fs.writeFileSync(
      path.join(this.runDir(candidate.staged.runId), "candidate.json"),
      JSON.stringify(candidate, null, 2),
    );
    return Promise.resolve();
  }

  commit(candidate: CandidateArtifact): Promise<CommittedArtifact> {
    if (candidate.approval.status !== "accepted") {
      return Promise.reject(
        new Error(
          "Cannot commit a candidate that has not been accepted (maker/checker + human approval required).",
        ),
      );
    }
    const dir = this.runDir(candidate.staged.runId);
    const committedPath = path.join(dir, "committed" + extFor(candidate.mimeType));
    atomicWriteSync(committedPath, safeReadBuf(candidate.candidatePath));
    const committed: CommittedArtifact = {
      candidate,
      committedIdentity: { id: sha256(safeReadBuf(candidate.candidatePath)), path: committedPath },
      committedVersion: new Date().toISOString(),
      committedAt: new Date().toISOString(),
      provenance: {
        sourceHash: candidate.staged.sourceHash,
        sourceVersion: candidate.staged.sourceVersion,
        candidateHash: candidate.candidateHash,
        evidenceRef: candidate.evidenceRef,
      },
      rollbackRef: committedPath,
    };
    fs.writeFileSync(path.join(dir, "committed.json"), JSON.stringify(committed, null, 2));
    return Promise.resolve(committed);
  }

  async rollback(committed: CommittedArtifact): Promise<CommittedArtifact | null> {
    // Recover the previous committed artifact if the atomic-write layer can.
    try {
      const restored = await rollbackLastWrite();
      if (!restored) return null;
      return committed;
    } catch {
      return null;
    }
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function extFor(mimeType: string): string {
  switch (mimeType) {
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
      return ".docx";
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
      return ".xlsx";
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
      return ".pptx";
    case "application/pdf":
      return ".pdf";
    case "text/plain":
      return ".txt";
    case "text/markdown":
      return ".md";
    default:
      return ".bin";
  }
}

function safeRead(p: string): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

function safeReadBuf(p: string): Buffer {
  try {
    return fs.readFileSync(p);
  } catch {
    return Buffer.alloc(0);
  }
}
