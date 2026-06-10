import readline from "node:readline";
import Anthropic from "@anthropic-ai/sdk";
import pc from "picocolors";
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
import {
  createCompactState,
  estimateContextSize,
  trackRecentFile,
  persistToolOutput,
  microCompact,
  compactHistory,
  COMPACT_TOOL_DEFINITION,
  CONTEXT_LIMIT,
} from "../persistence/compact";
import type {
  Message,
  ContentBlock,
  ToolDefinition,
  CompactState,
} from "../core/types";
const S06_SYSTEM = `You are a coding agent at ${WORKING_DIR}. Keep working step by step, and use compact if the conversation gets too long.`;
// 执行工具函数
// 为什么写文件和修改文件不需要持久化输出
// 原因： write_file 和 edit_file 的返回结果通常很短，只是操作状态，不是大内容。
// 真实实现里写入和修改文件也值得 trackRecentFile
async function runTool(
  block: { name: string; id: string; input: Record<string, unknown> },
  state: CompactState,
) {
  const { name, id, input } = block;
  //   如果执行的是bash
  if (name === "bash") {
    const command = input.command as string;
    const output = await BASE_HANDLERS[name]({ command });
    return persistToolOutput(id, output);
  }
  if (name === "read_file") {
    const filePath = input.path as string;
    trackRecentFile(state, filePath);
    const output = await BASE_HANDLERS[name]({
      path: filePath,
      limit: input.limit as number | undefined,
    });
    return persistToolOutput(id, output);
  }
  if (name === "write_file") {
    const filePath = input.path as string;
    trackRecentFile(state, filePath);
    const output = await BASE_HANDLERS[name]({
      path: filePath,
      content: input.content as string,
    });
    return output;
  }
  if (name === "edit_file") {
    const filePath = input.path as string;
    trackRecentFile(state, filePath);
    const output = await BASE_HANDLERS[name]({
      path: filePath,
      old_text: input.old_text as string,
      new_text: input.new_text as string,
    });
    return output;
  }
  if (name === "compact") {
    return "Compacting conversation...";
  }

  return `Unknown tool: ${name}`;
}

// agentloop + 压缩
async function agentLoop(
  message: Message[],
  state: CompactState,
  tools: ToolDefinition[],
) {
  const anthropicTools = convertToolsToAnthropic(tools);
  while (true) {
    // 每轮开始的时候进行微压缩
    message = microCompact(message);
    // 检查一下是否需要完整压缩
    if (estimateContextSize(message) > CONTEXT_LIMIT) {
      console.log(pc.green("需要完整压缩"));
      message = await compactHistory(message, state);
    }
    const id = createRunId();

    const response = await client.messages.create({
      model: MODEL!,
      system: S06_SYSTEM,
      messages: message,
      tools: anthropicTools,
      max_tokens: 8000,
    });
    await saveLlmResponse(id, 1, response);
    message.push({
      role: "assistant",
      content: response.content as ContentBlock[],
    });
    if (response.stop_reason !== "tool_use") {
      return;
    }
    const { content } = response;
    // 工具执行结果
    const result: ContentBlock[] = [];
    let manualCompact = false;
    let compactFocus: string | undefined;
    // 是否使用了todo工具
    let usedTodo = false;
    // 遍历response.content 因为返回的content是一个数组
    for (const i of content) {
      if (i.type !== "tool_use") {
        continue;
      }
      const toolBlock = i;
      const output = await runTool(
        {
          name: toolBlock.name,
          id: toolBlock.id,
          input: toolBlock.input as Record<string, unknown>,
        },
        state,
      );
      //   判断是否是手动压缩
      if (toolBlock.name === "compact") {
        manualCompact = true;
        const input = toolBlock.input as Record<string, unknown> | undefined;
        compactFocus = (input?.focus as string) || undefined;
      }
      result.push({
        type: "tool_result",
        content: output,
        tool_use_id: toolBlock.id,
      });
    }
    message.push({
      role: "user",
      content: result,
    });
    // 手动压缩，根据 focus 保留重点
    if (manualCompact) {
      message = await compactHistory(message, state, compactFocus);
    }
  }
}
//

const history: Message[] = [];
const TOOLS = [...BASH_TOOLS, COMPACT_TOOL_DEFINITION];
// 初始化压缩状态
const compactState = createCompactState();
async function main() {
  console.log(pc.green("开始执行"));
  console.log(pc.green("当前工作目录：" + WORKING_DIR));
  console.log(pc.green('Type "q" or "exit" to quit.\n'));
  //  创建readline实例,一问一答
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  //  交互循环
  prompt(rl);
}
const prompt = (rl: readline.Interface) => {
  rl.question("请输入命令：", async (query) => {
    const content = query.trim().toLowerCase();
    if (content === "q" || content === "exit") {
      rl.close();
      console.log(pc.green("退出执行"));
      return;
    }
    history.push({ role: "user", content: query });
    // agentloop
    try {
      await agentLoop(history, compactState, TOOLS);
      //   完成之后打印最后一条回复
      const reply = extractTextReply(history);
      if (reply) {
        console.log(reply);
      }
    } catch (error: any) {
      console.log(pc.red(error.message));
    }
  });
};
main();
