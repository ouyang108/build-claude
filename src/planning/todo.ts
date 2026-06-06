// Todo Manager - 会话内计划管理

import type { TodoItem } from "../core/types";
import pc from "picocolors";
// 多轮没更新计划触发提醒
const PLANNING_REMINDER_THRESHOLD = 3;
/** 计划最大条目数（防止过长） */
const MAX_PLAN_ITEMS = 12;

interface PlaningState {
  items: TodoItem[];
  roundsSinceUpdate: number;
}

// 会话内计划管理器
/**
 * 同一时间最多一个in_progress状态的计划
 * 目的：强调模型聚焦当前一步
 */
export class TodoManager {
  private state: PlaningState = {
    items: [],
    // 模型已经连续多少轮没有更新 todo 计划了
    roundsSinceUpdate: 0,
  };
  /**
   * 更新计划（模型整份重写）  重新提交一整份新的列表
   * @param items 新的计划条目列表
   * @returns 渲染后的可读文本
   */
  update(items: any[]) {
    if (items.length > MAX_PLAN_ITEMS) {
      throw new Error(`计划条目数不能超过${MAX_PLAN_ITEMS}个`);
    }
    const normalized: TodoItem[] = [];
    let inProgressCount = 0;
    for (let i = 0; i < items.length; i++) {
      const rawItem = items[i] as Record<string, unknown>;
      const content = String(rawItem.content || "").trim();
      const status: TodoItem["status"] = String(
        rawItem.status || "pending",
      ).toLocaleLowerCase() as TodoItem["status"];
      const activeForm = String(rawItem.activeForm || "").trim();
      //   如果没有内容
      if (!content) {
        throw new Error(`计划条目${i + 1}没有内容`);
      }
      if (!["pending", "in_progress", "completed"].includes(status)) {
        throw new Error(`计划条目${i + 1}状态${status}无效`);
      }
      //   检查in_progress状态是否超过1个
      if (status === "in_progress") {
        inProgressCount++;
      }
      normalized.push({
        id: String(i + 1),
        content,
        status,
        activeForm,
      });
      //   核心约束，最多一个in_progress状态的计划
      //   Agent 当前正在聚焦执行的那一步
      if (inProgressCount > 1) {
        throw new Error("同一时间最多一个in_progress状态的计划");
      }
    }
    //   替换原本的计划列表
    this.state.items = normalized;
    this.state.roundsSinceUpdate = 0;
    return this.render();
  }
  /**
   * 记录一轮没有更新计划
   */
  noteRoundWithoutUpdate(): void {
    this.state.roundsSinceUpdate++;
  }
  //   如果已经达到提醒阈值
  shouldReminder(): string | null {
    // 没有计划时不需要提醒
    if (this.state.items.length === 0) return null;
    if (this.state.roundsSinceUpdate >= PLANNING_REMINDER_THRESHOLD) {
      return "<reminder>Refresh your current plan before continuing.</reminder>";
    }
    return null;
  }
  //   将计划渲染为可读文本
  render(): string {
    if (this.state.items.length === 0) return "没有计划";
    const lines: string[] = [];
    for (const item of this.state.items) {
      const marker: Record<string, string> = {
        pending: "[ ]",
        in_progress: "[......]",
        completed: "[x]",
      };
      let line = `${marker[item.status]} ${item.content}`;
      if (item.status === "in_progress" && item.activeForm) {
        line += ` (${item.activeForm})`;
      }
      lines.push(line);
    }
    const completed = this.state.items.filter(
      (i) => i.status === "completed",
    ).length;
    lines.push(`\n(${completed}/${this.state.items.length} completed)`);
    // console.log(pc.green(lines.join("\n")));
    return lines.join("\n");
  }
  //   获取状态 调试用
  getStatus(): PlaningState {
    return this.state;
  }
}

import type { ToolDefinition } from "../core/types";

/**
 * todo 工具定义
 */
export const TODO_TOOL_DEFINITION: ToolDefinition = {
  name: "todo",
  // 中文：为多步骤工作重写当前会话计划。
  description: "Rewrite the current session plan for multi-step work.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            // 中文：这个步骤要做什么。
            content: { type: "string", description: "What this step does" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
              // 中文：这个步骤当前的状态。
              description: "Current status of this step",
            },
            activeForm: {
              type: "string",
              // 中文：可选的现在进行时标签，例如 "Reading the file"。
              description:
                'Optional present-continuous label (e.g., "Reading the file")',
            },
          },
          required: ["content", "status"],
        },
      },
    },
    required: ["items"],
  },
};

export const createTodoManager = (manager: TodoManager) => {
  return (input: Record<string, unknown>) => {
    const items = input.items as any[];
    try {
      return manager.update(items);
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : "Unknown error"}`;
    }
  };
};
