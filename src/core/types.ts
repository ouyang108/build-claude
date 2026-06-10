/**
 * 核心类型定义
 * 所有 session 共享的基础类型
 */

export interface Message {
  role: "user" | "assistant" | "system"; //assistant 是大模型，system 是系统提示
  content: string | ContentBlock[];
}
export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;
export interface TextBlock {
  type: "text";
  text: string;
}
// 工具调用
export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}
// 工具调用结果
export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}
// 工具定义
export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: ToolInputSchema;
}

// 工具输入参数
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, ToolProperty>;
  required?: string[];
}
// 工具输入参数属性
export interface ToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolProperty;
  properties?: Record<string, ToolProperty>; //  支持嵌套对象
  required?: string[]; //  支持嵌套对象的 required
}
// 工具处理函数
export type ToolHandler = (
  input: Record<string, unknown>,
) => string | Promise<string>;

export interface TodoItem {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

// ============================================================================
// Subagent 相关 (04)
// ============================================================================

export interface SubagentContext {
  messages: Message[]; // 子 Agent 自己的上下文（从空白开始）
  tools: ToolDefinition[]; // 子 Agent 可用的工具（过滤后的）
  handlers: Record<string, ToolHandler>; // 工具执行函数
  maxTurns: number; // 最大轮数，防止无限跑
  systemPrompt: string; // 子 Agent 的系统提示词
}

// skill
export interface SkillDocument {
  manifest: SkillManifest; // 元信息
  body: string; // 完整正文
}
// skill 元信息
export interface SkillManifest {
  name: string;
  description: string;
  path: string;
}

/**
 * 上下文压缩状态
 * @property hasCompacted 是否已做过完整压缩
 * @property lastSummary 最近一次压缩摘要
 * @property recentFiles 最近碰过的文件，压缩后可用于追踪和重新打开
 */
export interface CompactState {
  /** 是否已做过完整压缩 */
  hasCompacted: boolean;

  /** 最近一次压缩摘要 */
  lastSummary: string;

  /** 最近碰过的文件，压缩后可用于追踪和重新打开 */
  recentFiles: string[];
}
