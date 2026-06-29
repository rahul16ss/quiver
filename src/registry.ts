import { promises as fs } from "fs";
import * as path from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { ZodTypeAny } from "zod";

export interface Tool {
  name: string;
  description: string;
  parameters: ZodTypeAny;
  execute: (args: any) => Promise<any> | any;
}

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();
  private toolsDir: string;

  constructor(toolsDir?: string) {
    if (toolsDir) {
      this.toolsDir = toolsDir;
    } else {
      // Default to src/tools
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      this.toolsDir = path.join(currentDir, "tools");
    }
  }

  public getTool(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  public getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /**
   * Unregister a tool by name (US-5.2). Used by create_tool to ensure a
   * generated tool is NOT auto-activated before user approval.
   */
  public unregisterTool(name: string): boolean {
    return this.tools.delete(name);
  }

  /**
   * Scans the tools directory and dynamically imports/reloads all tools.
   */
  public async loadAll(): Promise<void> {
    try {
      // Ensure directory exists
      try {
        await fs.mkdir(this.toolsDir, { recursive: true });
      } catch (err: any) {
        // Ignore read-only / permission errors when loading default tools inside app.asar
        if (err.code !== "EROFS" && err.code !== "EACCES" && err.code !== "ENOTDIR") {
          throw err;
        }
      }
      const files = await fs.readdir(this.toolsDir);

      // Infra modules (runtime, sandbox) are NOT tools — exclude them from the
      // dynamic tool scan so startup is warning-free (US-5.2). They export
      // helpers/manifests, not a `tool` object, and would otherwise emit
      // spurious "Export 'tool' object not found" warnings.
      const INFRA_NON_TOOL = ["runtime", "sandbox"];
      const isToolFile = (file: string) =>
        (file.endsWith(".ts") || file.endsWith(".js")) &&
        !file.endsWith(".d.ts") &&
        !INFRA_NON_TOOL.some((n) => file.startsWith(n));

      const loadPromises = files
        .filter(isToolFile)
        .map(async file => {
          const filePath = path.join(this.toolsDir, file);
          await this.loadToolFile(filePath);
        });

      await Promise.all(loadPromises);
    } catch (error) {
      console.error("❌ Failed to load registry:", error);
    }
  }

  /**
   * Loads or reloads a specific tool file.
   * Employs cache-busting query params to bypass Node ESM caching.
   */
  public async loadToolFile(filePath: string): Promise<Tool | null> {
    try {
      // Resolve path and convert to file:/// URL
      const resolvedPath = path.resolve(filePath);
      const fileUrl = pathToFileURL(resolvedPath).href;
      
      // Cache-bust by appending timestamp query parameter
      const importUrl = `${fileUrl}?t=${Date.now()}`;
      const module = await import(importUrl);

      if (!module.tool) {
        console.warn(`⚠️  Skipped ${path.basename(filePath)}: Export 'tool' object not found.`);
        return null;
      }

      const tool: Tool = module.tool;
      if (!tool.name || !tool.description || !tool.parameters || typeof tool.execute !== "function") {
        console.warn(`⚠️  Skipped ${path.basename(filePath)}: Exported 'tool' object has invalid structure.`);
        return null;
      }

      this.tools.set(tool.name, tool);
      return tool;
    } catch (error) {
      console.error(`❌ Error importing tool from ${path.basename(filePath)}:`, error);
      return null;
    }
  }

  /**
   * Helper to serialize Zod schema parameters to standard OpenAI function-calling parameters
   */
  public static getOpenAIToolDefinition(tool: Tool): any {
    return {
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: ToolRegistry.zodToJsonSchema(tool.parameters),
      },
    };
  }

  private static zodToJsonSchema(schema: ZodTypeAny): any {
    const def = schema._def;
    if (def.typeName === "ZodObject") {
      const shape = def.shape();
      const properties: any = {};
      const required: string[] = [];

      for (const key of Object.keys(shape)) {
        const prop = shape[key];
        properties[key] = ToolRegistry.zodPropertyToJsonSchema(prop);
        if (!prop.isOptional()) {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        required: required.length > 0 ? required : undefined,
      };
    }
    return { type: "object" };
  }

  private static zodPropertyToJsonSchema(prop: ZodTypeAny): any {
    let type = prop._def.typeName;
    const description = prop.description;

    // Unwrap optionals / defaults
    if (type === "ZodOptional" || type === "ZodDefault") {
      const inner = prop._def.innerType;
      return {
        ...ToolRegistry.zodPropertyToJsonSchema(inner),
        ...(description ? { description } : {}),
      };
    }

    // Handle ZodObject (including objects inside arrays)
    if (type === "ZodObject") {
      return {
        ...ToolRegistry.zodToJsonSchema(prop),
        ...(description ? { description } : {}),
      };
    }

    let schemaType = "string";
    let items: any = undefined;

    if (type === "ZodString") {
      schemaType = "string";
    } else if (type === "ZodNumber") {
      schemaType = "number";
    } else if (type === "ZodBoolean") {
      schemaType = "boolean";
    } else if (type === "ZodArray") {
      schemaType = "array";
      items = ToolRegistry.zodPropertyToJsonSchema(prop._def.type);
    } else if (type === "ZodEnum") {
      return {
        type: "string",
        enum: prop._def.values,
        ...(description ? { description } : {}),
      };
    }

    return {
      type: schemaType,
      ...(items ? { items } : {}),
      ...(description ? { description } : {}),
    };
  }
}

export const globalRegistry = new ToolRegistry();
