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
const S03_SYSTEM = `You are a coding agent at ${WORKING_DIR}.
Use the todo tool for multi-step work.
Keep exactly one step in_progress when a task has multiple steps.
Refresh the plan as work advances. Prefer tools over prose.`;

// 初始化 TodoManager
const todoManager = new TodoManager();

const TOOLS = [...BASH_TOOLS, TODO_TOOL_DEFINITION];
// 工具所对应的handler方法
const TOOL_HANDLERS: Record<string, ToolHandler> = {
  ...BASE_HANDLERS,
  //  注册 todo 工具 更新todo计划
  todo: createTodoManager(todoManager),
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
        system: S03_SYSTEM,
        tools: TOOLS,
        handlers: TOOL_HANDLERS,
        todoManager,
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
