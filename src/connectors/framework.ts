/**
 * Connector Framework — US-17.16 / Build Order #6.
 *
 * Plugin architecture for data-vendor integrations (SPEC §4.4).
 *
 * Each vendor is a connector plugin with a standard interface:
 *   - search(query) → results[]
 *   - fetch(identifier, fields?) → structured data
 *
 * The agent calls connectors through a unified `data_query` tool.
 * No vendor-specific UI.
 *
 * Provenance is built into every response: each data point carries source
 * metadata (vendor, dataset, timestamp, API ref) that feeds lineage tags.
 *
 * The firm brings its own credentials. Quiver provides connector code; the
 * firm provides API keys. Quiver is not a data reseller.
 *
 * Sensitivity routing applies to data calls: a connector call that sends a
 * company name to an external API is a remote call — it goes through the same
 * MNPI redaction as model calls. Public-data connectors are always safe.
 *
 * Local caching with TTLs: financial data for memo purposes doesn't need
 * real-time freshness. Cache locally, work offline with already-fetched data.
 *
 * Data normalization: each connector normalizes to a common schema
 * (FinancialStatement, MarketQuote, Transaction, MacroIndicator) so the
 * agent doesn't care which vendor provided the data.
 *
 * Individual connectors are built per-engagement, not upfront. The framework
 * is MVP; the connectors are not.
 */

import * as path from "path";
import * as fs from "fs";
import * as os from "os";

// ─── Common schemas ────────────────────────────────────────────────────

export type ConnectorDataType =
  | "FinancialStatement"
  | "MarketQuote"
  | "Transaction"
  | "MacroIndicator"
  | "Filing"
  | "Generic";

export interface Provenance {
  vendor: string;
  dataset: string;
  timestamp: string;
  apiRef: string;
  url?: string;
}

export interface ConnectorResult {
  identifier: string;
  dataType: ConnectorDataType;
  data: Record<string, any>;
  provenance: Provenance;
  cachedAt?: string;
}

export interface SearchResult {
  identifier: string;
  name: string;
  description?: string;
  dataType: ConnectorDataType;
  provenance: Provenance;
}

// ─── Connector interface ───────────────────────────────────────────────

export interface DataConnector {
  /** Unique connector name (e.g., "edgar", "fred", "fmp") */
  name: string;
  /** Human-readable label */
  label: string;
  /** Data types this connector provides */
  dataTypes: ConnectorDataType[];
  /** Whether this connector requires API credentials */
  requiresAuth: boolean;
  /** Whether this connector sends sensitive identifiers to external APIs */
  sendsIdentifiers: boolean;
  /** Search for entities/data by query */
  search(query: string): Promise<SearchResult[]>;
  /** Fetch structured data by identifier */
  fetch(identifier: string, fields?: string[]): Promise<ConnectorResult>;
}

// ─── Connector registry ────────────────────────────────────────────────

export class ConnectorRegistry {
  private connectors: Map<string, DataConnector> = new Map();
  private cacheDir: string;
  private cacheTTL: number; // seconds

  constructor(cacheTTL: number = 3600) {
    this.cacheDir = path.join(os.homedir(), ".quiver", "connector-cache");
    this.cacheTTL = cacheTTL;
    try {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    } catch {}
  }

  /**
   * Register a connector plugin.
   */
  register(connector: DataConnector): void {
    this.connectors.set(connector.name, connector);
  }

  /**
   * Unregister a connector by name.
   */
  unregister(name: string): boolean {
    return this.connectors.delete(name);
  }

  /**
   * Get a connector by name.
   */
  get(name: string): DataConnector | undefined {
    return this.connectors.get(name);
  }

  /**
   * List all registered connectors.
   */
  list(): Array<{
    name: string;
    label: string;
    dataTypes: ConnectorDataType[];
    requiresAuth: boolean;
  }> {
    return Array.from(this.connectors.values()).map((c) => ({
      name: c.name,
      label: c.label,
      dataTypes: c.dataTypes,
      requiresAuth: c.requiresAuth,
    }));
  }

  /**
   * Search across all connectors (or a specific one).
   */
  async search(
    query: string,
    connectorName?: string,
  ): Promise<Array<SearchResult & { connector: string }>> {
    const results: Array<SearchResult & { connector: string }> = [];
    const connectors = connectorName
      ? [this.connectors.get(connectorName)].filter(Boolean)
      : Array.from(this.connectors.values());

    for (const connector of connectors) {
      if (!connector) continue;
      try {
        const connectorResults = await connector.search(query);
        for (const r of connectorResults) {
          results.push({ ...r, connector: connector.name });
        }
      } catch (err) {
        // Silently skip failed connectors — one vendor being down shouldn't block others
      }
    }

    return results;
  }

  /**
   * Fetch data from a specific connector, with local caching.
   */
  async fetch(
    connectorName: string,
    identifier: string,
    fields?: string[],
  ): Promise<ConnectorResult> {
    const connector = this.connectors.get(connectorName);
    if (!connector) {
      throw new Error(`Connector '${connectorName}' not registered.`);
    }

    // Check cache
    const cacheKey = this.cacheKey(connectorName, identifier, fields);
    const cached = this.readCache(cacheKey);
    if (cached) {
      return {
        ...cached,
        cachedAt: cached.cachedAt || new Date().toISOString(),
      };
    }

    // Fetch from connector
    const result = await connector.fetch(identifier, fields);

    // Write to cache
    this.writeCache(cacheKey, result);

    return result;
  }

  /**
   * Clear the connector cache.
   */
  clearCache(): void {
    try {
      const entries = fs.readdirSync(this.cacheDir);
      for (const entry of entries) {
        fs.unlinkSync(path.join(this.cacheDir, entry));
      }
    } catch {}
  }

  private cacheKey(
    connector: string,
    identifier: string,
    fields?: string[],
  ): string {
    const fieldStr = fields ? fields.sort().join(",") : "all";
    return `${connector}__${identifier}__${fieldStr}`;
  }

  private readCache(key: string): ConnectorResult | null {
    const cachePath = path.join(this.cacheDir, `${key}.json`);
    try {
      const stat = fs.statSync(cachePath);
      const age = (Date.now() - stat.mtimeMs) / 1000;
      if (age > this.cacheTTL) return null;
      const data = fs.readFileSync(cachePath, "utf8");
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  private writeCache(key: string, result: ConnectorResult): void {
    const cachePath = path.join(this.cacheDir, `${key}.json`);
    try {
      // C2: cap cache entry size so a single huge connector response (e.g. a
      // full multi-year SEC filing) can't write a multi-GB file to disk. Skip
      // caching oversized results rather than writing them.
      const serialized = JSON.stringify(result, null, 2);
      if (serialized.length > 50 * 1024 * 1024) return; // 50 MB cap
      fs.writeFileSync(cachePath, serialized);
    } catch {}
  }
}

// ─── Global registry ──────────────────────────────────────────────────

export const globalConnectorRegistry = new ConnectorRegistry();

/**
 * Load connectors from .quiver/connectors/ directory.
 * Each connector file exports a `connector` object implementing DataConnector.
 */
export async function loadConnectors(connectorsDir?: string): Promise<number> {
  const dir =
    connectorsDir || path.join(process.cwd(), ".quiver", "connectors");
  let count = 0;

  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".ts") || f.endsWith(".js"));

    for (const file of files) {
      try {
        const filePath = path.join(dir, file);
        const fileUrl = `file://${filePath}?t=${Date.now()}`;
        const module = await import(fileUrl);
        if (module.connector && module.connector.name) {
          globalConnectorRegistry.register(module.connector);
          count++;
        }
      } catch (err) {
        // Silently skip failed connector loads
      }
    }
  } catch {
    // Directory doesn't exist — no connectors to load
  }

  return count;
}
