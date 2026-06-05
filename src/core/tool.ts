// 工具定义
import { execSync } from "child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { ToolDefinition, ToolHandler } from "./types";
// 获取当前执行的目录
export const WORKING_DIR = process.cwd();

// 安全检查
const DANGEROUS_COMMANDS = [
  "rm -rf /", //删库跑路
  "sudo", //“超级管理员”通行证
  "shutdown", //关机
  "reboot", //重启
  "> /dev/", //乱写底层设备文件
];
// 安全文件执行路径
// 为什么要这么做：为了安全
export function safePath(path: string) {
  const absolutePath = resolve(WORKING_DIR, path);
  if (absolutePath.startsWith(WORKING_DIR)) {
    return absolutePath;
  }
  throw new Error("Path is not in working directory");
}

// 执行工具命令 执行命令
export const runBash: ToolHandler = (input) => {
  // 如果命令包含危险字符，直接返回错误
  const command = input.command as string;
  if (DANGEROUS_COMMANDS.some((dangerous) => command.includes(dangerous))) {
    return "Dangerous command";
  }
  // 执行命令
  try {
    // windows 使用powershell (utf-8 编码) 其他平台使用默认 shell
    const shell = process.platform === "win32" ? "powershell.exe" : undefined;
    const result = execSync(command, {
      cwd: WORKING_DIR,
      encoding: "utf-8",
      timeout: 120000,
      shell, //平台默认 shell
    });
    return result.toString().trim() || "no output";
  } catch (error) {
    if (error instanceof Error && "stdout" in error) {
      const execErr = error as Error & { stdout?: string; stderr?: string };
      return (
        (execErr.stdout || "") + (execErr.stderr || "") ||
        `Error: ${error.message}`
      );
    }
    return "Error: Unknown error";
  }
};
// 读取文件
export const runRead: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string);
  const limit = input.limit as number | undefined;
  try {
    const content = await readFile(filePath, "utf-8");
    const lines = content.split("\n");
    // 限制读取行数
    if (limit && limit < lines.length) {
      lines.length = limit;
      lines.push(`... (${lines.length - limit} more lines)`);
    }
    // 限制读取内容长度
    // 50000 字符
    return lines.join("\n").slice(0, 50000);
  } catch (error) {
    return `Error: ${error}`;
  }
};
// 写入文件
export const runWrite: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string);
  const content = input.content as string;

  try {
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, content, "utf-8");
    return `Wrote ${content.length} bytes to ${input.path}`;
  } catch (error) {
    return `Error: ${error}`;
  }
};
// 编辑文件
export const runEdit: ToolHandler = async (input) => {
  const filePath = safePath(input.path as string);
  const oldText = input.old_text as string;
  const newText = input.new_text as string;
  try {
    const content = await readFile(filePath, "utf-8");
    if (!content.includes(oldText)) {
      // 如果旧文本不存在，直接返回错误
      return `Error:Old text not found in file ${input.path}`;
    }
    const newContent = content.replace(oldText, newText);
    await writeFile(filePath, newContent, "utf-8");
    return `Replaced ${oldText} with ${newText} in ${input.path}`;
  } catch (error) {
    return `Error: ${error}`;
  }
};

// 定义工具 https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools
export const BASH_TOOLS: ToolDefinition[] = [
  {
    name: "bash",
    description: "Run a shell command.",
    input_schema: {
      type: "object", //表示input_schema是一个对象
      properties: {
        command: {
          type: "string", //表示command是一个字符串
          description: "The shell command to run.",
        },
      },
      required: ["command"],
    },
  },
  {
    name: "read_file",
    description: "Read file contents.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to read.",
        },
        limit: {
          type: "integer",
          description: "The maximum number of lines to read. Optional.",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to file.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to write.",
        },
        content: {
          type: "string",
          description: "The content to write to the file.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "Replace exact text in file.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "The path to the file to edit.",
        },
        old_text: { type: "string", description: "Text to find and replace" },
        new_text: { type: "string", description: "New text to insert" },
      },
      required: ["path", "old_text", "new_text"],
    },
  },
];
export const BASE_HANDLERS = {
  bash: runBash,
  read_file: runRead,
  write_file: runWrite,
  edit_file: runEdit,
};
