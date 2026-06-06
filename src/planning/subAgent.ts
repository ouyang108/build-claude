// 子subAgent
import Anthropic from "@anthropic-ai/sdk";
import { client, createRunId, MODEL, WORKING_DIR } from "../core/agent-loop";
import { BASH_TOOLS, BASE_HANDLERS } from "../core/tool";
import type {
  Message,
  ContentBlock,
  ToolDefinition,
  ToolHandler,
  SubagentContext,
} from "../core/types";
import { saveLlmResponse } from "../core/agent-loop";
import pc from "picocolors";
// 子agent最大轮数
const MAX_SUBAGENT_TURNS = 30;

// 子agent系统提示词
// 中文：你是工作目录下的编程子代理。完成给定任务，然后总结发现。最终总结要简洁。
const SUBAGENT_SYSTEM_PROMPT = `You are a coding subagent at ${WORKING_DIR}. Complete the given task, then summarize your findings. Be concise in your final summary.`;

// ============================================================================
// 工具定义
// ============================================================================

import type { ToolInputSchema } from "../core/types";
/**
 * task工具定义
 */
export const TASK_TOOL_DEFINITION: ToolDefinition = {
  name: "task",
  // 中文：启动一个上下文隔离的子代理来处理探索任务。适用于分析/搜索多个文件或目录、跨代码库收集信息、任务需要多步但父代理只关心最终总结的场景。只返回总结，保持父代理上下文干净。
  description:
    "Launch a subagent with isolated context for exploration tasks. Use this when: (1) analyzing/searching multiple files or directories, (2) gathering information across codebase, (3) the task needs multiple steps but only final summary matters. Returns only the summary, keeping parent context clean.",
  input_schema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        // 中文：子代理需要完成的具体任务。
        description: "The specific task for the subagent to complete",
      },
      description: {
        type: "string",
        // 中文：这个任务的简短标签，例如 "analyze core"、"find tests"。
        description:
          'Short label for this task (e.g., "analyze core", "find tests")',
      },
    },
    required: ["prompt"],
  },
};

// 子agent的工具
const SUBAGENT_TOOLS = BASH_TOOLS;
// 工具处理函数
const SUBAGENT_HANDLERS = BASE_HANDLERS;

// 运行子agent
export const runSubagent = async (prompt: string) => {
  const runId = createRunId();
  const messages: Message[] = [
    {
      role: "user",
      content: prompt,
    },
  ];
  const context: SubagentContext = {
    messages: messages,
    tools: SUBAGENT_TOOLS,
    handlers: SUBAGENT_HANDLERS,
    maxTurns: MAX_SUBAGENT_TURNS,
    systemPrompt: SUBAGENT_SYSTEM_PROMPT,
  };
  //   控制循环次数，最多maxTurns轮 只需要获取最后一次结果即可
  let lastResponse: Anthropic.Messages.Message | null = null;
  //   // 将tools转换成Anthropic支持的格式
  const anthropicTools: Anthropic.Messages.Tool[] = context.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Messages.Tool.InputSchema,
  }));
  for (let i = 0; i < context.maxTurns; i++) {
    const response = await client.messages.create({
      model: MODEL!,
      system: context.systemPrompt,
      messages: context.messages,
      tools: anthropicTools,
      max_tokens: 8000,
    });
    await saveLlmResponse(runId + "subAgent", i, response);
    lastResponse = response;
    const { content, stop_reason } = response;
    context.messages.push({
      role: "assistant",
      content: response.content as ContentBlock[],
    });
    // 如果模型决定停止，退出循环 子agent也可能需要调用工具，整体逻辑跟agent-loop一样的
    if (response.stop_reason !== "tool_use") {
      break;
    }
    // 工具执行结果
    const result: ContentBlock[] = [];

    // 遍历response.content 因为返回的content是一个数组
    for (const i of content) {
      // {name:'tool_name',input:{}}  返回格式
      // 如果type是一个tool_use(看claude文档) ，表示需要使用工具
      if (i.type === "tool_use") {
        // 从map中找出需要使用的工具的handler方法
        const handlerFunc = context.handlers[i.name];
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
      }
    }
    context.messages.push({
      role: "user",
      content: result as ContentBlock[],
    });
  }
  // 4. 只返回最终文本摘要（中间过程丢弃）
  if (lastResponse) {
    const textBlocks = lastResponse.content.filter(
      (b) => b.type === "text",
    ) as Anthropic.Messages.TextBlock[];
    if (textBlocks.length > 0) {
      return textBlocks.map((b) => b.text).join("\n");
    }
  }

  return "没有返回文本摘要";
};
/**
 * 创建 task handler
 */
export function createTaskHandler(): ToolHandler {
  return async (input: Record<string, unknown>): Promise<string> => {
    const prompt = input.prompt as string;
    const description = input.description as string | undefined;

    if (!prompt) {
      return "Error: prompt is required";
    }

    // 打印日志
    console.log(
      `\x1b[33m> task (${description || "subtask"}): ${prompt.slice(0, 80)}${prompt.length > 80 ? "..." : ""}\x1b[0m`,
    );

    // 运行子 Agent
    const summary = await runSubagent(prompt);

    // 打印摘要（截断显示）
    console.log(
      `\x1b[33m  ${summary.slice(0, 200)}${summary.length > 200 ? "..." : ""}\x1b[0m`,
    );

    return summary;
  };
}
