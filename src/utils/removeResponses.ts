// 删除.llm-responses文件夹下所有的文件
import { readdir, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

import { WORKING_DIR } from "../core/agent-loop";

const responsesDir = resolve(WORKING_DIR, ".llm-responses");

export async function clearLlmResponses() {
  if (!existsSync(responsesDir)) return;

  const entries = await readdir(responsesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const filePath = resolve(responsesDir, entry.name);

    if (!filePath.startsWith(responsesDir)) {
      throw new Error(`Unsafe path: ${filePath}`);
    }

    await unlink(filePath);
  }
}
