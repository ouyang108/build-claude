//  只有一个 bash 工具，展示核心循环模式

import readline from "node:readline";
import { agentLoop, extractTextReply, WORKING_DIR } from "../core/agent-loop";
import { BASH_TOOLS, runBash } from "../core/tool";
import pc from "picocolors";
import type { Message, ToolDefinition, ToolHandler } from "../core/types";

// 目前只是用bash

const TOOLS = [BASH_TOOLS[0]];
// 工具所对应的handler方法
const TOOL_HANDLERS = {
  bash: runBash,
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
      await agentLoop(history, { tools: TOOLS, handlers: TOOL_HANDLERS });
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
