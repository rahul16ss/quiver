/**
 * SqliteCheckpointSaver — Phase 4 (ADR-002).
 *
 * Durable, SQLite-backed checkpoint store — the default local backend for the
 * LangGraph execution engine. Uses Node's built-in `node:sqlite` (no extra
 * dependency). The backend is replaceable: a deployment can substitute any
 * `BaseCheckpointSaver` (e.g. Postgres) behind the same interface.
 *
 * Mirrors `MemorySaver`'s storage shape (checkpoint + metadata + parent id +
 * writes) but persists to SQLite tables so runs survive process restarts and
 * can be resumed.
 */

import { DatabaseSync } from "node:sqlite";
import * as path from "path";
import * as fs from "fs";
import { BaseCheckpointSaver, getCheckpointId } from "@langchain/langgraph-checkpoint";
import type {
  Checkpoint,
  CheckpointMetadata,
  CheckpointTuple,
  CheckpointListOptions,
  PendingWrite,
} from "@langchain/langgraph-checkpoint";
import type { RunnableConfig } from "@langchain/core/runnables";

const POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function assertSafeKey(field: string, value: unknown, opts: { allowEmpty?: boolean } = {}): void {
  if (typeof value !== "string") {
    throw new Error(`Invalid configurable value for key "${field}": expected a string identifier.`);
  }
  if (!opts.allowEmpty && value === "") {
    throw new Error(
      `Invalid configurable value for key "${field}": empty string is not permitted.`,
    );
  }
  if (POLLUTION_KEYS.has(value)) {
    throw new Error(
      `Invalid configurable value for key "${field}": value "${value}" is reserved (prototype pollution guard).`,
    );
  }
}

export class SqliteCheckpointSaver extends BaseCheckpointSaver {
  private db: DatabaseSync;

  /**
   * @param dbPath Filesystem path, or ":memory:" for an in-memory database
   *               (useful for tests).
   * @param serde Optional serializer; defaults to the base saver's JsonPlusSerializer.
   */
  constructor(
    dbPath: string,
    serde?: import("@langchain/langgraph-checkpoint").SerializerProtocol,
  ) {
    super(serde);
    if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA synchronous = NORMAL;");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS checkpoints (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        parent_checkpoint_id TEXT,
        checkpoint BLOB NOT NULL,
        metadata BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id)
      );
      CREATE TABLE IF NOT EXISTS writes (
        thread_id TEXT NOT NULL,
        checkpoint_ns TEXT NOT NULL,
        checkpoint_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        idx INTEGER NOT NULL,
        channel TEXT NOT NULL,
        value BLOB NOT NULL,
        PRIMARY KEY (thread_id, checkpoint_ns, checkpoint_id, task_id, idx)
      );
      CREATE INDEX IF NOT EXISTS idx_checkpoints_thread ON checkpoints(thread_id, checkpoint_ns, created_at DESC);
    `);
  }

  private ns(config: RunnableConfig): { threadId: string; ns: string; checkpointId?: string } {
    const threadId = config.configurable?.thread_id;
    const checkpointNs = config.configurable?.checkpoint_ns ?? "";
    const checkpointId = getCheckpointId(config);
    assertSafeKey("thread_id", threadId);
    assertSafeKey("checkpoint_ns", checkpointNs, { allowEmpty: true });
    if (checkpointId) assertSafeKey("checkpoint_id", checkpointId);
    return { threadId, ns: checkpointNs, checkpointId };
  }

  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    const { threadId, ns, checkpointId } = this.ns(config);
    let row: any;
    if (checkpointId) {
      row = this.db
        .prepare(
          "SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?",
        )
        .get(threadId, ns, checkpointId);
    } else {
      row = this.db
        .prepare(
          "SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY rowid DESC LIMIT 1",
        )
        .get(threadId, ns);
    }
    if (!row) return undefined;

    const checkpoint = (await this.serde.loadsTyped(
      "json",
      row.checkpoint as Uint8Array,
    )) as Checkpoint;
    const metadata = (await this.serde.loadsTyped(
      "json",
      row.metadata as Uint8Array,
    )) as CheckpointMetadata;

    const writes = this.db
      .prepare(
        "SELECT task_id, channel, value FROM writes WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=? ORDER BY idx",
      )
      .all(threadId, ns, row.checkpoint_id) as Array<{
      task_id: string;
      channel: string;
      value: Uint8Array;
    }>;
    const pendingWrites = await Promise.all(
      writes.map(
        async (w) =>
          [w.task_id, w.channel, await this.serde.loadsTyped("json", w.value)] as [
            string,
            string,
            unknown,
          ],
      ),
    );

    const tuple: CheckpointTuple = {
      config: {
        configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: row.checkpoint_id },
      },
      checkpoint,
      metadata,
      pendingWrites,
    };
    if (row.parent_checkpoint_id) {
      tuple.parentConfig = {
        configurable: {
          thread_id: threadId,
          checkpoint_ns: ns,
          checkpoint_id: row.parent_checkpoint_id,
        },
      };
    }
    return tuple;
  }

  async *list(
    config: RunnableConfig,
    options?: CheckpointListOptions,
  ): AsyncGenerator<CheckpointTuple> {
    const { threadId, ns } = this.ns(config);
    const beforeId = options?.before?.configurable?.checkpoint_id;
    const rows = beforeId
      ? this.db
          .prepare(
            "SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND created_at < (SELECT created_at FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? AND checkpoint_id=?) ORDER BY created_at DESC",
          )
          .all(threadId, ns, threadId, ns, beforeId)
      : this.db
          .prepare(
            "SELECT checkpoint_id, parent_checkpoint_id, checkpoint, metadata FROM checkpoints WHERE thread_id=? AND checkpoint_ns=? ORDER BY rowid DESC",
          )
          .all(threadId, ns);
    for (const row of rows as Array<any>) {
      const checkpoint = (await this.serde.loadsTyped(
        "json",
        row.checkpoint as Uint8Array,
      )) as Checkpoint;
      const metadata = (await this.serde.loadsTyped(
        "json",
        row.metadata as Uint8Array,
      )) as CheckpointMetadata;
      const tuple: CheckpointTuple = {
        config: {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: ns,
            checkpoint_id: row.checkpoint_id,
          },
        },
        checkpoint,
        metadata,
      };
      if (row.parent_checkpoint_id) {
        tuple.parentConfig = {
          configurable: {
            thread_id: threadId,
            checkpoint_ns: ns,
            checkpoint_id: row.parent_checkpoint_id,
          },
        };
      }
      yield tuple;
      if (options?.limit && --(options.limit as number) <= 0) return;
    }
  }

  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
  ): Promise<RunnableConfig> {
    const { threadId, ns } = this.ns(config);
    const parentId = config.configurable?.checkpoint_id;
    const [ckptType, ckptData] = await this.serde.dumpsTyped(checkpoint);
    const [metaType, metaData] = await this.serde.dumpsTyped(metadata);
    if (ckptType !== "json" || metaType !== "json") {
      throw new Error(
        `SqliteCheckpointSaver only supports json serde (got ${ckptType}/${metaType}).`,
      );
    }
    this.db
      .prepare(
        "INSERT OR REPLACE INTO checkpoints (thread_id, checkpoint_ns, checkpoint_id, parent_checkpoint_id, checkpoint, metadata, created_at) VALUES (?,?,?,?,?,?,?)",
      )
      .run(
        threadId,
        ns,
        checkpoint.id,
        parentId ?? null,
        Buffer.from(ckptData),
        Buffer.from(metaData),
        checkpoint.ts,
      );
    return {
      configurable: { thread_id: threadId, checkpoint_ns: ns, checkpoint_id: checkpoint.id },
    };
  }

  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    const { threadId, ns, checkpointId } = this.ns(config);
    if (!checkpointId) throw new Error("putWrites requires a checkpoint_id in config.");
    let idx = 0;
    for (const [channel, value] of writes) {
      const [type, data] = await this.serde.dumpsTyped(value);
      if (type !== "json")
        throw new Error(`SqliteCheckpointSaver only supports json serde (got ${type}).`);
      this.db
        .prepare(
          "INSERT OR REPLACE INTO writes (thread_id, checkpoint_ns, checkpoint_id, task_id, idx, channel, value) VALUES (?,?,?,?,?,?,?)",
        )
        .run(threadId, ns, checkpointId, taskId, idx++, channel, Buffer.from(data));
    }
  }

  async deleteThread(threadId: string): Promise<void> {
    assertSafeKey("thread_id", threadId);
    this.db.prepare("DELETE FROM writes WHERE thread_id=?").run(threadId);
    this.db.prepare("DELETE FROM checkpoints WHERE thread_id=?").run(threadId);
  }

  getNextVersion(current: number | string | undefined): number {
    return current === undefined ? 1 : typeof current === "number" ? current + 1 : 1;
  }

  close(): void {
    this.db.close();
  }
}
