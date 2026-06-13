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

//
/**
 * 权限相关
 * @property default 未命中规则时问用户
 * @property plan 只允许读，不允许写
 * @property auto  简单安全操作自动过，危险操作再问
 * */
export type PermissionMode = "default" | "plan" | "auto";

/**
 * 权限行为
 * @property allow 允许
 * @property deny 拒绝
 * @property ask 询问用户是否允许
 */
export type PermissionBehavior = "allow" | "deny" | "ask";

/**
 * 权限规则
 * @property tool 工具名称 或 *
 * @property behavior 权限行为
 * @property path 路径 路径 glob 模式
 * @property content 内容 glob 模式（用于 bash）
 */
export interface PermissionRule {
  tool: string;
  /** 权限行为 */
  behavior: PermissionBehavior;
  /** 路径 */
  path?: string;
  /** 内容 */
  content?: string;
}
/**
 * 权限决策结果
 * @property reason 决策原因
 * @property behavior 权限行为
 */
export interface PermissionDecision {
  reason: string;
  /** 权限行为 */
  behavior: PermissionBehavior;
}
/**
 * bash 验证失败
 * @property name 验证器名称
 * @property pattern 匹配的模式
 */
export interface BashValidationFailure {
  name: string; // 验证器名称
  pattern: string; // 匹配的模式
}

/**
 * 钩子事件
 * @property SessionStart 会话开始
 * @property PreToolUse 工具调用前  检查、拦截、修改输入
 * @property PostToolUse 工具调用后 日志、通知、追加输出
 */
export type HookEvent = "SessionStart" | "PreToolUse" | "PostToolUse";

/** 单个 Hook 的定义 */
/**
 * 钩子定义
 * @property matcher 工具名匹配，"*" 或省略表示所有工具
 * @property command 要执行的 shell 命令
 */
export interface HookDefinition {
  matcher?: string; // 工具名匹配，"*" 或省略表示所有工具
  command: string; // 要执行的 shell 命令
}
/** Hook 执行时的上下文（告诉 Hook 当前发生了什么） */
/**
 * 钩子上下文
 * @property tool_name 工具名
 * @property tool_input 工具输入参数
 * @property tool_output 工具输出结果（PostToolUse 才有）
 */
export interface HookContext {
  tool_name: string; // 工具名
  tool_input: Record<string, unknown>; // 工具输入参数
  tool_output?: string; // 工具输出结果（PostToolUse 才有）
}

/** Hook 执行后的结果 */
/**
 * 钩子结果
 * @property blocked 是否阻止工具执行
 * @property blockReason 阻止的原因
 * @property messages 要注入给模型的消息
 */
export interface HookResult {
  blocked: boolean; // 是否阻止工具执行
  blockReason?: string; // 阻止的原因
  messages: string[]; // 要注入给模型的消息
}
