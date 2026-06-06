//  只有一个 bash 工具，展示核心循环模式

import readline from "node:readline";
import { agentLoop, extractTextReply, WORKING_DIR } from "../core/agent-loop";
import { BASH_TOOLS, BASE_HANDLERS } from "../core/tool";
import pc from "picocolors";
import type { Message, ToolHandler } from "../core/types";
import {
  TodoManager,
  TODO_TOOL_DEFINITION,
  createTodoManager,
} from "../planning/todo";
import { exitWithCleanup, registerExitCleanup } from "../utils/exitCleanup";
import { TASK_TOOL_DEFINITION } from "../planning/subAgent";
import { createTaskHandler } from "../planning/subAgent";
const S04_SYSTEM = `You are a coding agent at ${WORKING_DIR}.

<task_tool_guidance>
Use the task tool when the request involves:
- Analyzing, exploring, or searching multiple files/directories
- Finding patterns or gathering information across the codebase
- Tasks where intermediate steps are noise but final summary matters
- Requests starting with "analyze", "find", "search", "list", "explore"

Do NOT use task tool for:
- Single file operations (read/edit one file)
- Simple bash commands
- Tasks that need current conversation context
</task_tool_guidance>

The task tool spawns a subagent with fresh messages. This keeps the parent context clean.
Directly handle simple tasks; delegate complex exploration to subagent.`;

const TOOLS = [...BASH_TOOLS, TASK_TOOL_DEFINITION];
// 工具所对应的handler方法
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  ...BASE_HANDLERS,
  //  注册 todo 工具 更新todo计划
  task: createTaskHandler(),
};

// 历史记录
const history: Message[] = [];

async function main() {
  console.log(pc.green("开始执行"));
  console.log(pc.green("当前工作目录：" + WORKING_DIR));
  console.log(pc.green('Type "q" or "exit" to quit.\n'));
  //  创建readline实例,一问一答
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  registerExitCleanup(rl);
  //  交互循环
  prompt(rl);
}
const prompt = (rl: readline.Interface) => {
  rl.question("请输入命令：", async (query) => {
    const content = query.trim().toLowerCase();
    if (content === "q" || content === "exit") {
      await exitWithCleanup(rl);
      return;
    }
    history.push({ role: "user", content: query });
    // agentloop
    try {
      await agentLoop(history, {
        system: S04_SYSTEM,
        tools: TOOLS,
        handlers: TOOL_HANDLERS,
      });
      //   完成之后打印最后一条回复
      const reply = extractTextReply(history);
      if (reply) {
        console.log(reply);
      }
    } catch (error: any) {
      console.log(pc.red(error.message));
    }
    // 继续提示，形成交互循环
    prompt(rl);
  });
};
main();
