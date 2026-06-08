/**
 *
 * Skill Loader - 按需知识加载
 * s05: 把可选知识从常驻 prompt 里拆出来，改成按需加载
 */
import pc from "picocolors";
import { ToolHandler, SkillDocument, ToolDefinition } from "../core/types";
// 读取目录
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { WORKING_DIR } from "../core/agent-loop";

// sklls目录
export const SKILLS_DIR = join(WORKING_DIR, "skills");

// skills注册器
export class SkillRegistry {
  private skills: Record<string, SkillDocument> = {};
  constructor(skillDir: string = SKILLS_DIR) {
    // this.loadSkills(skillDir);
  }
  async loadSkills(skillDir: string): Promise<void> {
    try {
      // withFileTypes 分清谁是文件、谁是文件夹
      const entries = await readdir(skillDir, { withFileTypes: true });
      // 遍历目录下的所有文件，加载技能文档
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const skillsPath = join(skillDir, entry.name, "SKILL.md");
        // 读取文件内容
        try {
          const content = await loadSkillContent(skillsPath);
          const { meta, body } = this.parseSkillContent(content);
          const name = meta.name || entry.name;
          const description = meta.description || "No description";
          this.skills[name] = {
            manifest: {
              name,
              description,
              path: skillsPath,
            },
            body: body.trim(),
          };
        } catch (error: any) {
          console.log(pc.red(error.message));
          continue;
        }
      }
    } catch (error: any) {
      console.log(pc.red(error.message));
    }
  }
  //   解析格式
  private parseSkillContent(content: string): {
    meta: Record<string, string>;
    body: string;
  } {
    const match = content.match(/^---\n(.*?)\n---\n(.*)/s);
    if (!match) {
      return { meta: {}, body: content };
    }
    const meta: Record<string, string> = {};
    for (const line of match[1].trim().split("\n")) {
      if (!line.includes(":")) continue;
      const colonIndex = line.indexOf(":");
      const key = line.slice(0, colonIndex).trim();
      const value = line.slice(colonIndex + 1).trim();
      meta[key] = value;
    }

    return { meta, body: match[2] };
  }
  // 加载内容
  loadFullText(name: string): string {
    const doc = this.skills[name];
    if (!doc) {
      const known = Object.keys(this.skills).sort().join(", ") || "(none)";
      return `Error: Unknown skill '${name}'. Available skills: ${known}`;
    }
    // 格式化输出 推荐用这种方式
    return `<skill name="${doc.manifest.name}">\n${doc.body}\n</skill>`;
  }
  //  生成skills目录，放到系统提示词中
  //  格式：
  //  - skill1: skill1 description
  //  - skill2: skill2 description
  //  - ...
  describeAvailable() {
    if (Object.keys(this.skills).length === 0) {
      return "(no skills available)";
    }

    const lines: string[] = [];
    for (const name of Object.keys(this.skills).sort()) {
      const doc = this.skills[name];
      lines.push(`- ${doc.manifest.name}: ${doc.manifest.description}`);
    }
    return lines.join("\n");
  }
}
// 读取文件内容
export async function loadSkillContent(filePath: string): Promise<string> {
  const content = await readFile(filePath, "utf-8");
  return content;
}
export const LOAD_SKILL_TOOL_DEFINITION: ToolDefinition = {
  name: "load_skill",
  description:
    "Load the full body of a named skill into the current context. Use this when you need specialized instructions for a task type.",
  input_schema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "The name of the skill to load",
      },
    },
    required: ["name"],
  },
};
export function createLoadSkillHandler(registry: SkillRegistry): ToolHandler {
  return (input: Record<string, unknown>): string => {
    const name = input.name as string;
    if (!name) {
      return "Error: skill name is required";
    }

    console.log(`\x1b[33m> load_skill: ${name}\x1b[0m`);
    const content = registry.loadFullText(name);
    console.log(`\x1b[33m  ${content.slice(0, 100)}...\x1b[0m`);
    return content;
  };
}
