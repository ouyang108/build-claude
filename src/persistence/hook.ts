/**
 * 钩子系统 - 在特定时机插入额外行为
 *  核心概念：
 * - 主循环只暴露"时机"（SessionStart、PreToolUse、PostToolUse）
 * - Hook 可以执行任何 shell 命令
 * - 退出码约定：0=继续，1=阻止，2=注入消息
 */

import { execSync } from "child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HookEvent,
  HookDefinition,
  HookContext,
  HookResult,
} from "../core/types";
import { WORKING_DIR } from "../core/tool";
import pc from "picocolors";
/**
 * Hook 命令的退出码约定
 *
 * 用户脚本通过退出码告诉系统要做什么：
 * - Continue：继续执行，什么都不做
 * - Block：阻止工具执行
 * - InjectMessage：继续执行，但注入消息给模型
 * @property Continue 退出码 0：继续执行
 * @property Block 退出码 1：阻止执行
 * @property InjectMessage 退出码 2：注入消息
 */
export enum HookExitCode {
  /** 退出码 0：继续执行 */
  Continue = 0,
  /** 退出码 1：阻止执行 */
  Block = 1,
  /** 退出码 2：注入消息 */
  InjectMessage = 2,
}
/** 单个 Hook 执行的返回结果（内部使用） */
/**
 * 钩子执行结果
 * @property exitCode 退出码（枚举）
 * @property stdout 正常输出
 * @property stderr 错误输出（注入消息从这里取）
 */
interface HookExecutionResult {
  exitCode: HookExitCode; // 退出码（枚举）
  stdout: string; // 正常输出
  stderr: string; // 错误输出（注入消息从这里取）
}
// hook 配置文件路径
const HOOK_CONFIG_PATH = join(WORKING_DIR, ".hooks.json");

// hook执行超时时间
const HOOK_TIMEOUT = 30; // 30 秒
// 工作区信任标记文件
/**
 * 工作区信任标记文件
 * 用于记录工作区是否已信任，防止未授权访问
 * 当这个文件存在时，工作区被信任，否则未被信任。
 */
const TRUST_MARKER = join(WORKING_DIR, ".claude", ".claude_trusted");

/**
 * hook管理器
 * 1. 加载配置 - 从 .hooks.json 读取 Hook 定义
 * 2. 执行 Hook - 运行 shell 命令
 * 3. 返回结果 - 告诉主循环是否阻止、是否注入消息
 */
export class HookManager {
  /** 存储所有 Hook 配置，按事件分类 */
  hooks: Record<HookEvent, HookDefinition[]>;
  /** 是否为 SDK 模式（SDK 模式下信任是隐式的） */
  private sdkMode: boolean;
  /**
   * 构造函数
   * 初始化 Hook 管理器，加载配置文件。
   * @param sdkMode 是否为 SDK 模式（SDK 模式下信任是隐式的）
   * @param configPath 配置文件路径
   */
  constructor(sdkMode: boolean = false, configPath: string = HOOK_CONFIG_PATH) {
    // 初始化空的 Hook 存储
    this.hooks = {
      SessionStart: [],
      PreToolUse: [],
      PostToolUse: [],
    };
    this.sdkMode = sdkMode;

    // 加载配置文件
    this.loadConfig(configPath);
  }
  private loadConfig(configPath: string) {
    // 如果没有配置文件，直接返回
    if (!existsSync(configPath)) {
      return;
    }
    console.log(configPath, "configPath");
    try {
      // 读取配置文件内容
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const hooksConfig = config.hooks || {};
      for (const event of [
        "SessionStart",
        "PreToolUse",
        "PostToolUse",
      ] as HookEvent[]) {
        if (Array.isArray(hooksConfig[event])) {
          // [{SessionStart: [{ "command": "echo 'Welcome to s08 Hook System!' >&2 && exit 2"}]}]
          this.hooks[event] = hooksConfig[event];
        }
      }
      console.log(pc.green("Hook 配置加载成功"));
    } catch (error) {
      console.error(pc.red("加载 Hook 配置文件失败"), error);
    }
  }
  //   检查工作区是否已信任
  /**
   * 检查工作区是否已信任
   * 安全机制：不信任的工作区不会执行 Hook
   */
  private checkWorkspaceTrust() {
    // 如果是sdk模式，默认信任
    if (this.sdkMode) {
      return true;
    }
    // 检查这个文件是否存在
    return existsSync(TRUST_MARKER);
  }

  /**
   * 检查 matcher 是否匹配工具名
   * 判断当前这个 Hook 要不要在当前工具上执行
   * @param matcher 匹配规则，如 "bash"、"write_file"、"*" 等
   * @param toolName 工具名
   * @returns 是否匹配
   */
  private isMatcherMatch(matcher: string | undefined, toolName: string) {
    if (matcher === "*" || !matcher) {
      return true;
    }
    return matcher === toolName;
  }

  //
  /**
   * 为什么hooks.json是一个数组，因为同一个时机可能要做多件互相独立的事
   * 比如 PreToolUse，工具执行前可以同时做：
   * 1. 打日志
   * 2. 检查命令是否安全
   * 3. 检查环境变量
   * 4. 对某些工具提示用户
   * 5. 对某些工具直接阻止
   */
  /**
   * 执行某个事件的所有hook
   * @param event 事件名（SessionStart、PreToolUse、PostToolUse）
   * @param context 当时的上下文（工具名、输入、输出）
   * @returns HookResult：是否阻止、是否注入消息
   */
  runHooks(event: HookEvent, context: HookContext): HookResult {
    const hooksResult: HookResult = {
      blocked: false,
      messages: [],
    };
    // 判断是不是信任区域
    if (!this.checkWorkspaceTrust()) {
      return hooksResult;
    }
    // 取出当前事件的所有hook
    const hooks = this.hooks[event] || [];
    // 遍历
    for (const hook of hooks) {
      // 检查 matcher 是否匹配工具名 如果不匹配跳过
      //   因为部分hook只在特定工具执行
      if (!this.isMatcherMatch(hook.matcher, context.tool_name)) {
        continue;
      }
      //    执行hook
      const hookResult = this.executeHook(hook, context, event);
      //   根据退出码处理结果
      //   如果是0，不做处理
      if (hookResult.exitCode === HookExitCode.Continue) {
        continue;
      } else if (hookResult.exitCode === HookExitCode.Block) {
        //   如果是1，阻止
        hooksResult.blocked = true;
        //   把hook的stdout和stderr都添加到信息中
        hooksResult.blockReason = hookResult.stderr.trim() || "Blocked by hook";
        break;
      } else if (hookResult.exitCode === HookExitCode.InjectMessage) {
        //   如果是2，注入消息
        const message = hookResult.stderr.trim();
        if (message) {
          hooksResult.messages.push(message);
        }
      }
    }
    return hooksResult;
  }

  /**
   * 执行单个 Hook 命令
   *
   * @param hook Hook 定义
   * @param context 执行上下文
   * @param event 当前事件名
   * @returns HookExecutionResult：退出码 + stdout + stderr
   */
  private executeHook(
    hook: HookDefinition,
    context: HookContext,
    event: HookEvent,
  ): HookExecutionResult {
    const env: Record<string, string | undefined> = {
      ...process.env,
      HOOK_EVENT: event, // 事件名
      HOOK_TOOL_NAME: context.tool_name, // 工具名
      HOOK_INPUT: JSON.stringify(context.tool_input), // 输入
    };
    // 工具调用后  还需要额外输入一个output
    if (context.tool_output) {
      env.HOOK_OUTPUT = JSON.stringify(context.tool_output);
    }
    // 执行shell命令
    try {
      const output = execSync(hook.command, {
        cwd: WORKING_DIR,
        env: env,
        encoding: "utf-8",
        timeout: HOOK_TIMEOUT * 1000,
        stdio: "pipe", // 捕获 stdout 和 stderr
      });
      //   命令执行成功
      //   退出码是0
      console.log(pc.green("Hook 命令执行成功:" + output));
      return {
        exitCode: HookExitCode.Continue,
        stdout: output,
        stderr: "",
      };
    } catch (error) {
      // 命令执行失败 退出码是非0
      const execError = error as {
        // 在 Node.js 里，execSync 执行命令失败时抛出的错误对象通常会带这些字段：
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      // 获取原始退出码（shell 返回的数字）
      const rawExitCode = execError.status || 1;
      // 2 是注入消息 1 是阻止
      const exitCode: HookExitCode =
        rawExitCode === 2 ? HookExitCode.InjectMessage : HookExitCode.Block;
      // 获取 stdout 和 stderr 即使错误也有可能会有stdout
      const stdout = execError.stdout || "";
      const stderr = execError.stderr || "";
      //   分别打印stdout和stderr
      console.log(pc.green("[Hook stdout] 命令执行成功:" + stdout));
      console.log(pc.red("[Hook stderr] 命令执行失败:" + stderr));
      return {
        exitCode,
        stdout: stdout,
        stderr: stderr,
      };
    }
  }
}
