import { z } from "zod";
import { config } from "../config.js";
import { Tool } from "../registry.js";

export const tool: Tool = {
  name: "github",
  description: "Native tool to perform GitHub API operations including retrieving files/folders, finding issues/PRs, creating issues, comments, or pull requests.",
  parameters: z.object({
    action: z.enum(["get_contents", "get_issue", "create_issue", "create_comment", "create_pr", "list_prs"])
      .describe("The GitHub action to perform."),
    repo: z.string().describe("The repository coordinates formatted as 'owner/repo' (e.g., 'vercel/next.js')."),
    path: z.string().optional().describe("The file path inside the repository (required for 'get_contents' if targeting a specific file or subdirectory)."),
    issueNumber: z.number().optional().describe("The issue or pull request number (required for 'get_issue' or 'create_comment')."),
    title: z.string().optional().describe("The title (required for 'create_issue' or 'create_pr')."),
    body: z.string().optional().describe("The markdown body content (required for 'create_issue', 'create_comment', or 'create_pr')."),
    head: z.string().optional().describe("The source branch name containing changes (required for 'create_pr')."),
    base: z.string().optional().describe("The target branch name to merge into (required for 'create_pr')."),
  }),
  execute: async ({ action, repo, path: filePath, issueNumber, title, body, head, base }) => {
    const token = config.githubToken;
    const headers: Record<string, string> = {
      "Accept": "application/vnd.github+json",
      "User-Agent": "quiver-agent",
      "X-GitHub-Api-Version": "2022-11-28",
    };

    if (token) {
      headers["Authorization"] = `Bearer ${token}`;
    }

    const baseUrl = "https://api.github.com";

    try {
      switch (action) {
        case "get_contents": {
          const contentUrl = `${baseUrl}/repos/${repo}/contents/${filePath || ""}`;
          const response = await fetch(contentUrl, { headers });
          if (!response.ok) {
            return `Error fetching GitHub contents for '${repo}/${filePath || ""}': ${response.status} (${response.statusText})`;
          }
          const data = await response.json() as any;
          if (Array.isArray(data)) {
            // Folder contents list
            const files = data.map((item: any) => `- ${item.type}: ${item.name} (${item.path})`).join("\n");
            return `Contents of folder '${filePath || "/"}':\n\n${files}`;
          } else if (data.content) {
            // Single file content (base64 encoded by GitHub)
            const decoded = Buffer.from(data.content, "base64").toString("utf8");
            return `File contents of '${data.path}':\n\n\`\`\`\n${decoded}\n\`\`\``;
          }
          return JSON.stringify(data, null, 2);
        }
        case "get_issue": {
          if (issueNumber === undefined) {
            return "Error: issueNumber is required for 'get_issue' action.";
          }
          const issueUrl = `${baseUrl}/repos/${repo}/issues/${issueNumber}`;
          const response = await fetch(issueUrl, { headers });
          if (!response.ok) {
            return `Error fetching issue/PR #${issueNumber} from '${repo}': ${response.status}`;
          }
          const issue = await response.json() as any;
          
          // Also fetch comments
          const commentsUrl = `${baseUrl}/repos/${repo}/issues/${issueNumber}/comments`;
          const commentsResponse = await fetch(commentsUrl, { headers });
          let commentsList = "";
          if (commentsResponse.ok) {
            const comments = await commentsResponse.json() as any[];
            commentsList = comments.map((c: any) => `\n--- Comment by @${c.user?.login} at ${c.created_at} ---\n${c.body}`).join("\n");
          }

          return `### #${issue.number} ${issue.title} (State: ${issue.state})\nCreator: @${issue.user?.login}\nCreated: ${issue.created_at}\n\n${issue.body}\n${commentsList}`;
        }
        case "create_issue": {
          if (!title) return "Error: title is required for 'create_issue' action.";
          if (!token) return "Error: Authentication token (GITHUB_TOKEN) is required to perform write actions on GitHub.";
          const issueUrl = `${baseUrl}/repos/${repo}/issues`;
          const response = await fetch(issueUrl, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ title, body }),
          });
          if (!response.ok) {
            const text = await response.text();
            return `Error creating issue: ${response.status} - ${text}`;
          }
          const issue = await response.json() as any;
          return `Issue created successfully: #${issue.number} - ${issue.html_url}`;
        }
        case "create_comment": {
          if (issueNumber === undefined || !body) {
            return "Error: issueNumber and body are required for 'create_comment' action.";
          }
          if (!token) return "Error: Authentication token (GITHUB_TOKEN) is required to write comments on GitHub.";
          const commentUrl = `${baseUrl}/repos/${repo}/issues/${issueNumber}/comments`;
          const response = await fetch(commentUrl, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ body }),
          });
          if (!response.ok) {
            const text = await response.text();
            return `Error creating comment: ${response.status} - ${text}`;
          }
          const comment = await response.json() as any;
          return `Comment posted successfully: ${comment.html_url}`;
        }
        case "create_pr": {
          if (!title || !head || !base) {
            return "Error: title, head, and base parameters are required for 'create_pr' action.";
          }
          if (!token) return "Error: Authentication token (GITHUB_TOKEN) is required to create pull requests on GitHub.";
          const prUrl = `${baseUrl}/repos/${repo}/pulls`;
          const response = await fetch(prUrl, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ title, body, head, base }),
          });
          if (!response.ok) {
            const text = await response.text();
            return `Error creating pull request: ${response.status} - ${text}`;
          }
          const pr = await response.json() as any;
          return `Pull Request created successfully: #${pr.number} - ${pr.html_url}`;
        }
        case "list_prs": {
          const prsUrl = `${baseUrl}/repos/${repo}/pulls?state=open`;
          const response = await fetch(prsUrl, { headers });
          if (!response.ok) {
            return `Error listing PRs for '${repo}': ${response.status}`;
          }
          const prs = await response.json() as any[];
          const list = prs.map((pr: any) => `- #${pr.number} ${pr.title} by @${pr.user?.login} (${pr.html_url})`).join("\n");
          return list.length > 0 ? `Open Pull Requests for '${repo}':\n\n${list}` : `No open pull requests found for '${repo}'.`;
        }
        default:
          return `Error: Unknown action '${action}'`;
      }
    } catch (error: any) {
      return `GitHub API connection error: ${error.message}`;
    }
  },
};
