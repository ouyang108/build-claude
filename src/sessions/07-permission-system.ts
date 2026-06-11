import readline from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import {
  client,
  convertToolsToAnthropic,
  createRunId,
  extractTextReply,
  MODEL,
  saveLlmResponse,
  WORKING_DIR,
} from "../core/agent-loop";
import { BASH_TOOLS, BASE_HANDLERS } from "../core/tool";
import { PermissionManager } from "../persistence/permission";
import type {
  Message,
  ToolResultBlock,
  ContentBlock,
  ToolUseBlock,
  TextBlock,
  PermissionDecision,
} from "../core/types";
import picocolors from "picocolors";

// ============================================================================
// 系统提示词
// ============================================================================

const S07_SYSTEM = `You are a coding agent at ${WORKING_DIR}. Use tools to solve tasks.
The user controls permissions. Some tool calls may be denied.

Available permission modes:
- default: Ask user for unmatched operations
- plan: Read-only mode, no writes allowed
- auto: Auto-approve safe reads, ask for writes

Use /mode to switch modes. Use /rules to see current rules.`;

async function agentLoopPermission(
  messages: Message[],
  perms: PermissionManager,
  rl: readline.Interface,
): Promise<void> {
  const anthropicTools = convertToolsToAnthropic(BASH_TOOLS);
  while (true) {
    const id = createRunId();

    const response = await client.messages.create({
      model: MODEL!,
      system: S07_SYSTEM,
      messages: messages,
      tools: anthropicTools,
      max_tokens: 8000,
    });
    const { content } = response;
    await saveLlmResponse(id, 1, response);
    const assistantContent: ContentBlock[] = content.map((block) => {
      if (block.type === "text") {
        // 我不需要权限处理
        return { type: "text", text: block.text } as TextBlock;
      }
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: block.input as Record<string, unknown>,
        } as ToolUseBlock;
      }
      // thinking block 等，转换为 text
      return { type: "text", text: JSON.stringify(block) } as TextBlock;
    });

    messages.push({ role: "assistant", content: assistantContent });
    // 如果模型决定停止，退出循环
    if (response.stop_reason !== "tool_use") {
      return;
    }

    // 工具调用
    const result: ToolResultBlock[] = [];
    for (const i of content) {
      if (i.type !== "tool_use") {
        continue;
      }
      //   工具名称
      const toolName = i.name;
      //   工具输入
      const toolInput = i.input as Record<string, unknown>;
      // 判断工具是否有权限
      const permission = perms.check(toolName, toolInput);
      let output = "";
      if (permission.behavior === "deny") {
        output = `Permission denied: ${permission.reason}`;
        console.log(picocolors.red(`Tool ${toolName} is denied.`));
      } else if (permission.behavior === "ask") {
        console.log(
          picocolors.yellow(`Tool ${toolName} is asked for permission.`),
        );
        // 等待用户输入
        const answer = await new Promise<string>((resolve) => {
          rl.question("  Allow? (y/n/always): ", resolve);
        });
        perms.handleUserResponse(answer);
        const lowercaseAnswer = answer.toLowerCase();
        if (
          lowercaseAnswer === "always" ||
          lowercaseAnswer === "y" ||
          lowercaseAnswer === "yes"
        ) {
          // 调用工具
          const handler = BASE_HANDLERS[toolName as keyof typeof BASE_HANDLERS];
          output = handler
            ? await handler(toolInput)
            : `Unknown tool: ${toolName}`;
        }
        if (lowercaseAnswer === "n" || lowercaseAnswer === "no") {
          output = `Permission denied by user for ${toolName}`;
        }
      } else {
        // allow - 直接执行
        const handler = BASE_HANDLERS[toolName as keyof typeof BASE_HANDLERS];
        output = handler
          ? await handler(toolInput)
          : `Unknown tool: ${toolName}`;
        console.log(`> ${toolName}: ${output.slice(0, 200)}`);
      }
      result.push({
        type: "tool_result",
        tool_use_id: i.id,
        content: output,
      });
    }
    // 将结果追加回消息
    messages.push({ role: "user", content: result });
  }
}

async function main() {
  console.log(picocolors.green("开始执行"));
  console.log(picocolors.green("当前工作目录：" + WORKING_DIR));
  console.log(picocolors.green('Type "q" or "exit" to quit.\n'));
  //  创建readline实例,一问一答
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  //   选择权限模式
  console.log(picocolors.green("请选择权限模式： default, plan, auto"));
  const mode = await new Promise<string>((resolve) => {
    rl.question("请输入权限模式：", resolve);
  });
  //  如果权限不对
  if (!["default", "plan", "auto"].includes(mode)) {
    console.log(picocolors.red("Invalid mode, using default"));
  }
  const perms = new PermissionManager(
    ["default", "plan", "auto"].includes(mode)
      ? (mode as "default" | "plan" | "auto")
      : "default",
  );
  const history: Message[] = [];

  while (true) {
    // 获取用户输入
    let query: string;
    try {
      query = await new Promise<string>((resolve, reject) => {
        rl.question("\x1b[36ms07 >> \x1b[0m", (answer) => {
          if (answer === undefined) reject(new Error("EOF"));
          else resolve(answer);
        });
      });
    } catch {
      break;
    }

    if (
      query.trim().toLowerCase() === "q" ||
      query.trim().toLowerCase() === "exit" ||
      !query.trim()
    ) {
      break;
    }

    // /mode 命令切换模式
    if (query.startsWith("/mode")) {
      const parts = query.split(" ");
      if (
        parts.length === 2 &&
        ["default", "plan", "auto"].includes(parts[1])
      ) {
        perms.mode = parts[1] as "default" | "plan" | "auto";
        console.log(picocolors.green(`[Switched to ${parts[1]} mode]`));
      } else {
        console.log(picocolors.red("Usage: /mode <default|plan|auto>"));
      }
      continue;
    }

    // /rules 命令查看当前规则
    if (query.trim() === "/rules") {
      console.log("Current rules:");
      perms.rules.forEach((rule, i) => {
        console.log(`  ${i}: ${JSON.stringify(rule)}`);
      });
      continue;
    }

    // /validators 命令查看 Bash 验证器
    if (query.trim() === "/validators") {
      console.log(picocolors.green("Bash validators:"));
      console.log(picocolors.green("  - sudo: \\bsudo\\b"));
      console.log(picocolors.green("  - rm_rf: \\brm\\s+(-[a-zA-Z]*)?r"));
      console.log(picocolors.green("  - shell_metachar: [;&|`$]"));
      console.log(picocolors.green("  - cmd_substitution: \\$\\("));
      console.log(picocolors.green("  - ifs_injection: \\bIFS\\s*="));
      continue;
    }

    // 正常请求
    history.push({ role: "user", content: query });
    await agentLoopPermission(history, perms, rl);

    // 显示最后的回复
    const lastContent = history[history.length - 1]?.content;
    if (Array.isArray(lastContent)) {
      for (const block of lastContent) {
        if (block.type === "text") {
          console.log(block.text);
        }
      }
    }
    console.log("");
  }
}

main();
