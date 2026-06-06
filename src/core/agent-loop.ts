/**
 * Agent Loop - 核心循环（通用版本）
 * 支持 dispatch map 模式，可用于 s01, s02 等所有 session
 */
import Anthropic from "@anthropic-ai/sdk";
import { execSync } from "child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pc from "picocolors";
import "dotenv/config";
import {
  ContentBlock,
  Message,
  ToolDefinition,
  ToolHandler,
  ToolResultBlock,
} from "./types";
import { TodoManager } from "../planning/todo";
// 在 Windows 系统的 cmd.exe 环境下，强制将当前终端的字符编码切换为 UTF-8（代码页 65001），
// 并隐藏该命令的所有控制台输出
if (process.platform === "win32") {
  try {
    execSync("chcp 65001 >nul 2>&1", { shell: "cmd.exe" });
  } catch {
    // ignore
  }
}
// 获取当前执行的目录
export const WORKING_DIR = process.cwd();
export const MODEL = process.env.ANTHROPIC_MODEL;
const LLM_RESPONSE_DIR = join(WORKING_DIR, ".llm-responses");

export const apiKey = process.env.ANTHROPIC_AUTH_TOKEN;
export const baseURL = process.env.ANTHROPIC_BASE_URL;
console.log(baseURL);

export const client = new Anthropic({
  apiKey,
  baseURL,
});

export function createRunId(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
// 保存llm响应
export async function saveLlmResponse(
  runId: string,
  turn: number,
  response: Anthropic.Messages.Message,
) {
  await mkdir(LLM_RESPONSE_DIR, { recursive: true });

  const fileName = `${runId}-turn-${String(turn).padStart(3, "0")}.json`;
  const filePath = join(LLM_RESPONSE_DIR, fileName);
  await writeFile(filePath, JSON.stringify(response, null, 2), "utf-8");
  console.log(pc.gray(`LLM response saved: ${filePath}`));
}

interface AgentLoopOptions {
  tools: ToolDefinition[];
  handlers: Record<string, ToolHandler>;
  system?: string;
  //   TODO:后续处理
  todoManager?: TodoManager;
}

// agent-loop 核心循环
/**
 * 核心流程
 * 1.首先将用户信息，系统提示词和注册的tools发送给llm
 * 2.此时llm会根据提问和tools判断是否需要调用工具，如果判断不需要agentLoop停止
 * 3.如果需要，通过ai返回的tools name找到对应的tools 的handler方法 如果没有这个方法，将这个找不到的内容重新拼接到message里面重新发送给llm
 * 4.如果找到了，agent（电脑）去执行这个命令，将执行的结果拼装成message的格式，然后再重新拼接之前的message发送给llm
 * 5.重复执行以上流程，直到llm返回给你说结束了，停止
 */
/**
 *
 * @param messages 消息 需要发送给llm的
 * @param options 选项
 */
export async function agentLoop(
  messages: Message[],
  options: AgentLoopOptions,
) {
  // todoManager TODO:s03 处理todoManager
  const { tools, handlers, system, todoManager } = options;
  //   系统提示词
  const systemPrompt =
    system ??
    // 中文：你是工作目录下的编程代理。使用工具解决任务。直接行动，不要只解释。
    `You are a coding agent at ${WORKING_DIR}. Use tools to solve tasks. Act, don't explain.`;
  // 将tools转换成Anthropic支持的格式
  const anthropicTools: Anthropic.Messages.Tool[] = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema as Anthropic.Messages.Tool.InputSchema,
  }));
  const runId = createRunId();
  let turn = 0;

  //   循环执行
  while (true) {
    // 调用llm
    const response = await client.messages.create({
      model: MODEL!,
      messages: messages,
      system: systemPrompt,
      tools: anthropicTools,
      max_tokens: 8000,
    });
    turn++;
    await saveLlmResponse(runId, turn, response);
    const { content, stop_reason } = response;

    // 将llm返回的消息添加到messages里面
    messages.push({
      role: "assistant",
      content: content as ContentBlock[],
    });
    if (stop_reason !== "tool_use") {
      return;
    }
    // 工具执行结果
    const result: (ToolResultBlock | { type: "text"; text: string })[] = [];
    // 是否使用了todo工具
    let usedTodo = false;
    // 遍历response.content 因为返回的content是一个数组
    for (const i of content) {
      // {name:'tool_name',input:{}}  返回格式
      // 如果type是一个tool_use(看claude文档) ，表示需要使用工具
      if (i.type === "tool_use") {
        // 从map中找出需要使用的工具的handler方法
        const handlerFunc = handlers[i.name];
        // 如果没有找到
        if (!handlerFunc) {
          console.log(pc.red(`未找到工具 ${i.name} 的处理函数`));
          //   将结果添加到result里面
          result.push({
            type: "tool_result",
            tool_use_id: i.id,
            content: `未找到工具 ${i.name} 的处理函数`,
          });
          continue;
        }
        console.log(pc.green(`找到工具 ${i.name} 的处理函数`));
        // 执行工具处理函数
        const output = await handlerFunc(i.input as Record<string, unknown>);
        //   将结果添加到result里面
        result.push({
          type: "tool_result",
          tool_use_id: i.id,
          content: output,
        });
        // 当使用了todo工具时，llm返回的数据就有可能包含todo，但是无法确定是哪一个轮次返回的
        if (i.name === "todo") {
          usedTodo = true;
          console.log(pc.cyan(output));
        }
      }
    }
    // 03：任务列表管理 — 跟踪未更新轮次，需要时插入提醒
    if (todoManager) {
      if (!usedTodo) {
        todoManager.noteRoundWithoutUpdate();
        const reminder = todoManager.shouldReminder();
        if (reminder) {
          result.push({ type: "text", text: reminder });
        }
      }
      // 如果 usedTodo 为 true，update() 内部已重置 roundsSinceUpdate = 0
    }

    // 将上下文所有内容添加到messages里面

    // 重新调用llm 因为需要llm去判断是否还需要继续使用工具还是中断循环
    messages.push({
      role: "user",
      content: result as ContentBlock[],
    });
  }
}
export function extractTextReply(messages: Message[]): string {
  const lastContent = messages[messages.length - 1]?.content;
  if (Array.isArray(lastContent)) {
    for (const block of lastContent) {
      if (block.type === "text") {
        return block.text;
      }
    }
  }
  return "";
}
