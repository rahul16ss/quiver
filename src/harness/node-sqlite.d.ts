/**
 * Ambient types for Node's built-in `node:sqlite` (experimental in Node 22).
 * The installed @types/node does not yet ship these. Only the surface used by
 * SqliteCheckpointSaver is declared.
 */
declare module "node:sqlite" {
  export interface StatementSync {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
    run(...params: unknown[]): { changes: number; lastInsertRowid: number | bigint };
  }
  export class DatabaseSync {
    constructor(location: string);
    exec(sql: string): void;
    prepare(sql: string): StatementSync;
    close(): void;
  }
  export const constants: Record<string, number>;
  export function backup(source: DatabaseSync, dest: DatabaseSync): void;
}