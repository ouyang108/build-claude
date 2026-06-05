import type readline from "node:readline";
import pc from "picocolors";

import { clearLlmResponses } from "./removeResponses";

let isExiting = false;

export async function exitWithCleanup(rl?: readline.Interface) {
  if (isExiting) return;
  isExiting = true;

  try {
    await clearLlmResponses();
  } catch (error: any) {
    console.log(pc.red(`清理 LLM 响应失败：${error.message}`));
  } finally {
    rl?.close();
    console.log(pc.green("退出执行"));
    process.exit(0);
  }
}

export function registerExitCleanup(rl: readline.Interface) {
  process.once("SIGINT", () => {
    void exitWithCleanup(rl);
  });
}
