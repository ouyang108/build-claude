// 核心管道: deny_rules -> mode_check -> allow_rules -> ask_user
/**
 * 工具调用
 *  ↓
 * 1. deny_rules   命中拒绝规则？是 → deny
 *  ↓ 否
 * 2. mode_check   当前模式是否直接决定？比如 plan 模式禁止写入
 *  ↓ 未决定
 * 3. allow_rules  命中允许规则？是 → allow
 *  ↓ 否
 * 4. ask_user     还不确定 → 问用户 y / n / always
 */

import {
  PermissionMode,
  PermissionRule,
  PermissionDecision,
  BashValidationFailure,
} from "../core/types";
import pc from "picocolors";
// 只读工具
const READ_ONLY_TOOLS = ["read_file", "glob", "grep"];
// 写入工具
const WRITE_ONLY_TOOLS = ["write_file", "edit_file", "bash"];

/**
 * Bash 安全校验器
 * Bash 是最危险的工具，需要单独的安全检查
 * 检查明显危险的模式：sudo, rm -rf, shell 元字符等
 */
export class BashSecurityValidator {
  private validators: Array<{ name: string; pattern: RegExp }> = [
    { name: "sudo", pattern: /\bsudo\b/ }, // 权限提升
    { name: "rm_rf", pattern: /\brm\s+(-[a-zA-Z]*)?r/ }, // 删除
    { name: "shell_metachar", pattern: /[;&|`$]/ }, // shell 元字符
    { name: "cmd_substitution", pattern: /\$\(|`[^`]*`/ }, // 命令替换
    { name: "ifs_injection", pattern: /\bIFS\s*=/ }, // IFS 操控
  ];
  //   校验
  validate(command: string): BashValidationFailure[] {
    const failures: BashValidationFailure[] = [];
    for (const { name, pattern } of this.validators) {
      if (pattern.test(command)) {
        failures.push({ name, pattern: pattern.source });
      }
    }
    return failures;
  }

  /**
   * 是否通过所有验证（无失败）
   */
  isSafe(command: string): boolean {
    return this.validate(command).length === 0;
  }
  //   失败原因
  describeFailures(command: string) {
    const failures = this.validate(command);
    if (failures.length === 0) {
      return "No issues detected";
    }
    // 被拦截的命令描述
    const parts = failures.map((f) => `${f.name} (pattern: ${f.pattern})`);
    return "Security flags: " + parts.join(", ");
  }

  //   如果是严重的危险操作，直接拒绝 deny_rules
  isSevereFailure(failure: BashValidationFailure): boolean {
    return failure.name === "sudo" || failure.name === "rm_rf";
  }
}
/** 默认权限规则 */
const DEFAULT_RULES: PermissionRule[] = [
  // 永久拒绝危险模式
  { tool: "bash", content: "rm -rf /", behavior: "deny" },
  { tool: "bash", content: "sudo *", behavior: "deny" },
  // 允许读取任何文件
  { tool: "read_file", path: "*", behavior: "allow" },
];

// 权限管理器
/**
 * 核心管道：
 * 1. deny rules  -> 命中了就拒绝（优先挡掉危险）
 * 2. mode check  -> 根据当前模式决定
 * 3. allow rules -> 命中了就放行
 * 4. ask user    -> 剩下的交给用户确认
 */
export class PermissionManager {
  mode: PermissionMode = "default";
  rules: PermissionRule[];
  consecutiveDenials: number = 0;
  maxConsecutiveDenials: number = 3;
  private bashValidator: BashSecurityValidator;
  /** 待处理的用户确认请求 */
  pendingAsk?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    resolve: (approved: boolean) => void;
  };
  constructor(mode: PermissionMode = "default", rules?: PermissionRule[]) {
    if (!["default", "plan", "auto"].includes(mode)) {
      throw new Error("mode must be default,plan,auto");
    }
    this.mode = mode;
    this.rules = rules ?? DEFAULT_RULES;
    this.bashValidator = new BashSecurityValidator();
  }

  //   权限检查
  /**
   * 返回决策结果：{behavior,reason}
   * @param toolName 工具名称
   * @param toolInput 工具输入
   * @returns 权限决策结果
   */
  check(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): PermissionDecision {
    //    如果工具是bash （在 deny rules 之前）
    if (toolName === "bash") {
      const command = (toolInput.command as string) ?? "";
      const failures = this.bashValidator.validate(command);
      if (failures.length > 0) {
        // 如果是严重的直接拒绝,其他的正常
        const result = failures.some((f) =>
          this.bashValidator.isSevereFailure(f),
        );
        if (result) {
          return {
            behavior: "deny",
            reason: `Bash validator: ${this.bashValidator.describeFailures(command)}`,
          };
        }
        // 其他模式 escalate to ask
        const desc = this.bashValidator.describeFailures(command);
        return { behavior: "ask", reason: `Bash validator flagged: ${desc}` };
      }
    }
    // 永久阻止 匹配是否拒绝
    for (const rule of this.rules) {
      if (rule.behavior !== "deny") continue;
      if (this.matchesRule(rule, toolName, toolInput)) {
        return {
          behavior: "deny",
          reason: `Blocked by deny rule: ${JSON.stringify(rule)}`,
        };
      }
    }

    // mode check
    if (this.mode === "plan") {
      if (WRITE_ONLY_TOOLS.includes(toolName)) {
        return {
          behavior: "deny",
          reason: "Plan mode: write operations are blocked",
        };
      }
      return { behavior: "allow", reason: "Plan mode: read-only allowed" };
    }

    if (this.mode === "auto") {
      if (READ_ONLY_TOOLS.includes(toolName)) {
        return {
          behavior: "allow",
          reason: "Auto mode: read-only tool auto-approved",
        };
      }
    }

    for (const rule of this.rules) {
      if (rule.behavior !== "allow") continue;
      if (this.matchesRule(rule, toolName, toolInput)) {
        this.consecutiveDenials = 0;
        return {
          behavior: "allow",
          reason: `Matched allow rule: ${JSON.stringify(rule)}`,
        };
      }
    }
    return {
      behavior: "ask",
      reason: `No rule matched for ${toolName}, asking user`,
    };
  }

  //   用户交互确认
  /**
   * y 用户交互确认 n 拒绝 always 永久允许
   * @param toolName 工具名称
   * @param toolInput 工具输入
   * @returns 用户确认结果
   */
  async askUser(
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<boolean> {
    // 用户输入
    const preview = JSON.stringify(toolInput).slice(0, 200);
    console.log(pc.green(`\n  [Permission] ${toolName}: ${preview}`));
    return new Promise((resolve) => {
      this.pendingAsk = { toolName, toolInput, resolve };
    });
  }
  // 处理当用户确认
  handleUserResponse(approved: string) {
    if (!this.pendingAsk) return;
    const { resolve } = this.pendingAsk;
    if (approved === "always") {
      // 这个工具永久允许被调用，不需要再确认了
      this.rules.push({
        behavior: "allow",
        tool: this.pendingAsk.toolName,
        path: "*",
      });
      this.consecutiveDenials = 0;
      resolve(true);
    } else if (approved === "y" || approved === "yes") {
      this.consecutiveDenials = 0;
      resolve(true); //本次允许，不写入规则
    } else {
      this.consecutiveDenials++;
      if (this.consecutiveDenials >= this.maxConsecutiveDenials) {
        console.log(
          pc.red(
            `\n  [Permission] ${this.pendingAsk.toolName}: ${this.pendingAsk.toolInput.command}`,
          ),
        );
      }
      resolve(false);
    }
    this.pendingAsk = undefined;
  }

  //   匹配规则
  private matchesRule(
    rule: PermissionRule,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): boolean {
    // 比较工具名称
    if (rule.tool !== toolName && rule.tool !== "*") return false;
    // 内容匹配
    if (
      rule.content !== undefined &&
      !this.globMatch(toolInput.command as string, rule.content)
    )
      return false;
    // 路径模式匹配（使用简单的 glob 匹配）
    if (rule.path && rule.path !== "*") {
      const path = (toolInput.path as string) ?? "";
      if (!this.globMatch(path, rule.path)) return false;
    }
    return true;
  }
  /**
   * 简单的 glob 模式匹配
   *
   * 支持: * (任意字符), ? (单个字符)
   */
  private globMatch(str: string, pattern: string): boolean {
    // 将 glob 模式转换为正则表达式
    const regexPattern = pattern
      .replace(/[.+^${}()|[\]\\]/g, "\\$&") // 转义特殊字符
      .replace(/\*/g, ".*") // * -> .*
      .replace(/\?/g, "."); // ? -> .

    return new RegExp(`^${regexPattern}$`).test(str);
  }
}

// function BashCheck(toolName: string, toolInput: Record<string, unknown>, bashValidator: BashSecurityValidator) {
//   const command = (toolInput.command as string) ?? "";
//   const failures = bashValidator.validate(command);
//   if (failures.length > 0) {
//     // 如果是严重的直接拒绝,其他的正常
//     const result = failures.some((f) => bashValidator.isSevereFailure(f));
//     if (result) {
//       return {
//         behavior: "deny",
//         reason: bashValidator.describeFailures(command),
//       };
//     }
//     // 其他模式 escalate to ask
//     const desc = bashValidator.describeFailures(command);
//     return { behavior: "ask", reason: `Bash validator flagged: ${desc}` };
//   }
// }
