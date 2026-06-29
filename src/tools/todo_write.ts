import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Tool } from "../registry.js";
import { getProjectSessionsDir } from "../paths.js";

/**
 * TodoWrite — manage a task checklist during coding sessions.
 * The agent uses this to track multi-step tasks, show progress to the user,
 * and maintain state across turns.
 *
 * Todos are stored in the project's .sessions/ directory as a JSON file,
 * so they persist across the session and can be resumed.
 */

interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: "high" | "medium" | "low";
}

function getTodoFilePath(): string {
  return path.join(getProjectSessionsDir(), "todos.json");
}

async function loadTodos(): Promise<TodoItem[]> {
  try {
    const content = await fs.readFile(getTodoFilePath(), "utf8");
    return JSON.parse(content);
  } catch {
    return [];
  }
}

async function saveTodos(todos: TodoItem[]): Promise<void> {
  const filePath = getTodoFilePath();
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, JSON.stringify(todos, null, 2), "utf8");
}

function formatTodos(todos: TodoItem[]): string {
  if (todos.length === 0) {
    return "No todos. Use todo_write to create a task list.";
  }

  const statusIcon: Record<string, string> = {
    pending: "○",
    in_progress: "◐",
    completed: "✓",
  };

  const priorityLabel: Record<string, string> = {
    high: "[HIGH]",
    medium: "",
    low: "[LOW]",
  };

  const lines: string[] = ["Todo List:", ""];
  for (const todo of todos) {
    const icon = statusIcon[todo.status] || "○";
    const priority = priorityLabel[todo.priority] || "";
    lines.push(`  ${icon} ${todo.content}${priority ? ` ${priority}` : ""}`);
  }

  const completed = todos.filter((t) => t.status === "completed").length;
  lines.push("");
  lines.push(`Progress: ${completed}/${todos.length} completed`);

  return lines.join("\n");
}

export const tool: Tool = {
  name: "todo_write",
  description:
    "Manages a task checklist for the current coding session. Use this to break complex tasks into trackable steps, show progress to the user, and maintain state across turns. " +
    "The todo list persists in the project's session directory and survives context compaction. " +
    "Always create a todo list before starting multi-step work. Update status as you progress. " +
    "This helps the user see what you're doing and helps you stay organized on complex tasks.",
  parameters: z.object({
    action: z
      .enum(["create", "update", "list", "clear"])
      .describe(
        "Action to perform: 'create' to replace the entire todo list with new items, 'update' to modify a single todo's status, 'list' to read the current todos, 'clear' to remove all todos.",
      ),
    todos: z
      .array(
        z.object({
          content: z.string().describe("The task description."),
          priority: z
            .enum(["high", "medium", "low"])
            .optional()
            .describe("Priority level. Default: medium."),
        }),
      )
      .optional()
      .describe(
        "New todo items. Required for 'create' action. Each item gets an auto-generated ID.",
      ),
    todoId: z
      .string()
      .optional()
      .describe("The ID of the todo to update. Required for 'update' action."),
    status: z
      .enum(["pending", "in_progress", "completed"])
      .optional()
      .describe("New status for the todo. Required for 'update' action."),
  }),
  execute: async ({
    action,
    todos: newTodos,
    todoId,
    status,
  }: {
    action: "create" | "update" | "list" | "clear";
    todos?: { content: string; priority?: "high" | "medium" | "low" }[];
    todoId?: string;
    status?: "pending" | "in_progress" | "completed";
  }) => {
    try {
      switch (action) {
        case "create": {
          if (!newTodos || newTodos.length === 0) {
            return "Error: 'todos' array is required for 'create' action.";
          }
          const missingContent = newTodos.findIndex(
            (it) => !it || typeof it.content !== "string" || !it.content.trim(),
          );
          if (missingContent !== -1) {
            return `Error: todo item #${missingContent + 1} is missing a non-empty 'content' string. Every todo requires a 'content' field.`;
          }

          const todos: TodoItem[] = newTodos.map((item, index) => ({
            id: `todo_${Date.now()}_${index}`,
            content: item.content,
            status: "pending" as const,
            priority: item.priority || "medium",
          }));

          await saveTodos(todos);
          return `Created ${todos.length} todo items.\n\n${formatTodos(todos)}`;
        }

        case "update": {
          if (!todoId) {
            return "Error: 'todoId' is required for 'update' action.";
          }
          if (!status) {
            return "Error: 'status' is required for 'update' action.";
          }

          const todos = await loadTodos();
          const todo = todos.find((t) => t.id === todoId);
          if (!todo) {
            return `Error: Todo with ID '${todoId}' not found.`;
          }

          todo.status = status;
          await saveTodos(todos);
          return `Updated todo '${todoId}' to '${status}'.\n\n${formatTodos(todos)}`;
        }

        case "list": {
          const todos = await loadTodos();
          return formatTodos(todos);
        }

        case "clear": {
          await saveTodos([]);
          return "Todo list cleared.";
        }

        default:
          return `Error: Unknown action '${action}'. Use create, update, list, or clear.`;
      }
    } catch (error: any) {
      return `Error managing todos: ${error.message}`;
    }
  },
};
