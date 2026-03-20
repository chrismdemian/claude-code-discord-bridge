import * as path from "node:path";

const EXT_TO_LANG: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".jsx": "jsx",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".rb": "ruby",
  ".php": "php",
  ".c": "c",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".h": "c",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".json": "json",
  ".jsonl": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".sql": "sql",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".fish": "fish",
  ".md": "markdown",
  ".dockerfile": "dockerfile",
  ".tf": "hcl",
  ".vue": "vue",
  ".svelte": "svelte",
  ".lua": "lua",
  ".r": "r",
  ".scala": "scala",
  ".zig": "zig",
  ".ex": "elixir",
  ".exs": "elixir",
  ".erl": "erlang",
  ".dart": "dart",
  ".graphql": "graphql",
  ".gql": "graphql",
  ".proto": "protobuf",
  ".ini": "ini",
  ".env": "bash",
  ".ps1": "powershell",
  ".bat": "batch",
  ".cmd": "batch",
};

/** Infer Discord code block language from file path extension */
export function inferLanguage(filePath: string): string {
  const basename = path.basename(filePath).toLowerCase();
  if (basename === "dockerfile") return "dockerfile";
  if (basename === "makefile") return "makefile";

  const ext = path.extname(filePath).toLowerCase();
  return EXT_TO_LANG[ext] ?? "";
}
