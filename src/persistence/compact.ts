/**
 * Context Compact - 上下文压缩
 * 06: 三层压缩策略实现无限会话
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import pc from "picocolors";
import type {
  Message,
  ToolResultBlock,
  ToolDefinition,
  ToolInputSchema,
  CompactState,
} from "../core/types";
import {
  createRunId,
  MODEL,
  saveLlmResponse,
  WORKING_DIR,
} from "../core/agent-loop";
import { client } from "../core/agent-loop";
import Anthropic from "@anthropic-ai/sdk";

/**
 * 上下文上限
 */
export const CONTEXT_LIMIT = 50000;
/**
 * 保留最近多少个完整工具结果
 */
const KEEP_RECENT_TOOL_RESULTS = 3;
/**
 * 输出超过多少的时候需要写入磁盘
 */
export const PERSIST_THRESHOLD = 30000;

// 预览字符数
const PREVIEW_CHARS = 2000;
/** transcript 目录 */
const TRANSCRIPT_DIR = join(WORKING_DIR, ".transcripts");

/** tool results 目录 */
const TOOL_RESULTS_DIR = join(WORKING_DIR, ".task_outputs", "tool-results");

/**
 * 估算上下文大小
 * @param messages 上下文消息
 * @returns 上下文大小
 */
export function estimateContextSize(messages: Message[]): number {
  return JSON.stringify(messages).length;
}

/**
 * 记录最近访问的文件
 * 原因：记录最近访问的文件，是为了压缩后还能恢复工作现场。上下文压缩会把很长的历史变成一段 summary。压缩之后，模型可能还记得：
 ** 刚才分析了工具系统 ** 但它可能不记得具体文件路径 如果后续继续工作就不知道文件路径了

 * @param state 上下文状态
 * @param filePath 文件路径
 */
export function trackRecentFile(state: CompactState, filePath: string) {
  // 已经存在的放到最后面
  const index = state.recentFiles.indexOf(filePath);
  if (index !== -1) {
    state.recentFiles.splice(index, 1);
  }
  state.recentFiles.push(filePath);
  // 只保留最近5个文件
  state.recentFiles = state.recentFiles.slice(-5);
}

/**
 * 大工具输出持久化，就是当执行某一个工具返回的结果很大的时候，需要写入磁盘
 * 如果工具输出太大，就把完整内容保存到磁盘，只把路径和预览返回给模型
 * @param toolUseId 工具使用id
 * @param output 工具输出内容
 */
export async function persistToolOutput(toolUseId: string, output: string) {
  if (output.length <= PERSIST_THRESHOLD) {
    // 不需要持久化
    return output;
  }
  await mkdir(TOOL_RESULTS_DIR, { recursive: true });
  const storedPath = join(TOOL_RESULTS_DIR, `${toolUseId}.txt`);
  await writeFile(storedPath, output);
  //   生成预览标记
  const preview = output.slice(0, PREVIEW_CHARS);
  // 生成路径标记
  const relPath = relative(WORKING_DIR, storedPath);
  return `<persisted-output>
Full output saved to: ${relPath}
Preview:
${preview}
</persisted-output>`;
}

// 微压缩
/**
 * 每次工具输出都不算特别大，
 * 但工具调用次数多了以后，
 * 很多 tool_result 累积起来也会撑大上下文

 */
// 先收集所有 tool_result 块
/**
 * 收集所有 tool_result 块
 * @param messages 上下文消息
 * @returns 所有 tool_result 块
 */
function collectToolResultBlocks(messages: Message[]) {
  const blocks = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    // 执行工具的结果给llm是以user角色发送的 见agent-loop.ts
    if (
      message.role !== "user" ||
      !Array.isArray(message.content) ||
      message.content.some((block) => block.type !== "tool_result")
    ) {
      continue;
    }
    for (
      let blockIndex = 0;
      blockIndex < message.content.length;
      blockIndex++
    ) {
      const block = message.content[blockIndex];
      if (block?.type === "tool_result") {
        blocks.push({
          index,
          blockIndex,
          block: block as ToolResultBlock,
        });
      }
    }
  }
  return blocks;
}
// 微压缩：只保留KEEP_RECENT_TOOL_RESULTS个 tool_result 块
/**
 * 微压缩：只保留KEEP_RECENT_TOOL_RESULTS个 tool_result 块
 * @param message 上下文消息
 */
export function microCompact(message: Message[]) {
  const toolResultBlocks = collectToolResultBlocks(message);
  // 只压缩旧的（非最近 3 个）
  const oldResults = toolResultBlocks.slice(0, -KEEP_RECENT_TOOL_RESULTS);

  for (const { block } of oldResults) {
    const content = block.content;
    if (typeof content !== "string" || content.length <= 120) {
      continue;
    }
    // 替换为占位提示  之前的工具结果已经被压缩了。如果你需要完整细节，请重新运行工具。
    block.content =
      "[Earlier tool result compacted. Re-run the tool if you need full detail.]";
  }
  return message;
}

// 完整压缩
/**
 * 将历史消息备份到 transcript 目录
 *   transcript（完整历史备份）
 */
async function writeTranscript(messages: Message[]): Promise<string> {
  await mkdir(TRANSCRIPT_DIR, { recursive: true });

  const timestamp = Math.floor(Date.now() / 1000);
  const transcriptPath = join(TRANSCRIPT_DIR, `transcript_${timestamp}.jsonl`);

  const lines = messages.map((m) => JSON.stringify(m));
  await writeFile(transcriptPath, lines.join("\n"), "utf-8");

  return transcriptPath;
}

// 通过llm生成历史摘要
async function summarizeHistory(messages: Message[]) {
  // 简单截取前80000个字符
  const conversation = JSON.stringify(messages).slice(0, 80000);
  const prompt = `Summarize this coding-agent conversation so work can continue.
Preserve:
1. The current goal
2. Important findings and decisions
3. Files read or changed
4. Remaining work
5. User constraints and preferences
Be compact but concrete.

${conversation}`;
  const id = createRunId();
  const response = await client.messages.create({
    model: MODEL!,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 2000,
  });
  await saveLlmResponse(id + "压缩", 1, response);
  // 提取文本
  // 调用模型不是为了让模型继续执行工具，而是为了拿到一段可以放回上下文里的文字总结
  const textBlocks = response.content.filter(
    (b) => b.type === "text",
  ) as Anthropic.Messages.TextBlock[];
  return textBlocks
    .map((b) => b.text)
    .join("\n")
    .trim();
}

// 完整压缩流程
// 先历史备份，然后通过llm生成历史摘要，最后返回新的压缩后的上下文
/**
 * 完整压缩流程
 * @param messages 上下文消息
 * @param state 压缩状态
 * @param focus 重点 手动压缩时指定
 * @returns 压缩后的上下文
 */
export async function compactHistory(
  messages: Message[],
  state: CompactState,
  focus?: string,
): Promise<Message[]> {
  const transcriptPath = await writeTranscript(messages);
  console.log(pc.green(`已备份历史消息到 ${transcriptPath}`));
  let summary = await summarizeHistory(messages);
  // 如果是手动的话
  if (focus) {
    summary += `\n\nFocus to preserve next: ${focus}`;
  }
  //添加最近的文件
  /**
   * 压缩之后，很多旧消息和工具结果会被删掉或变成摘要，agent 可能不再“记得”之前具体看过哪些文件。
   * 于是这里把 state.recentFiles 作为线索保留下来：
   */
  if (state.recentFiles.length > 0) {
    const recentLines = state.recentFiles.map((f) => `- ${f}`).join("\n");
    summary += `\n\nRecent files read or changed: ${recentLines}`;
  }
  // 5. 更新状态
  state.hasCompacted = true;
  state.lastSummary = summary;
  return [
    {
      role: "user",
      content: `This conversation was compacted so the agent can continue working.\n\n${summary}`,
    },
  ];
}

/**
 * compact 工具定义
 */
export const COMPACT_TOOL_DEFINITION: ToolDefinition = {
  name: "compact",
  description:
    "Summarize earlier conversation so work can continue in a smaller context. Use when the conversation gets too long.",
  input_schema: {
    type: "object",
    properties: {
      focus: {
        type: "string",
        description: "Specific focus to preserve in summary",
      },
    },
  } as ToolInputSchema,
};

// ============================================================================
// 创建初始 CompactState
// ============================================================================

/**
 * 创建初始压缩状态
 */
export function createCompactState(): CompactState {
  return {
    hasCompacted: false,
    lastSummary: "",
    recentFiles: [],
  };
}
