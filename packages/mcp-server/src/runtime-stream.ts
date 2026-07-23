/**
 * @input  依赖：CLI stdout 的任意分片与逐行 JSON 事件
 * @output 导出：运行时公开文本事件类型和抗分片 JSONL 解码器
 * @pos    Claude stream-json 与 Codex --json 的共用增量解析基础层
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type RuntimeTextEvent =
  | { operation: "reset" }
  | { operation: "append"; content: string }
  | { operation: "replace"; content: string };

export type RuntimeTextListener = (event: RuntimeTextEvent) => void;

export class JsonLineDecoder {
  #buffer = "";

  constructor(private readonly listener: (value: unknown) => void) {}

  push(chunk: string): void {
    this.#buffer += chunk;
    while (true) {
      const boundary = this.#buffer.indexOf("\n");
      if (boundary < 0) {
        return;
      }
      const line = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 1);
      this.#parse(line);
    }
  }

  flush(): void {
    this.#parse(this.#buffer);
    this.#buffer = "";
  }

  #parse(line: string): void {
    const candidate = line.trim();
    if (!candidate.startsWith("{")) {
      return;
    }
    try {
      this.listener(JSON.parse(candidate) as unknown);
    } catch {
      // 忽略未知提示、损坏行或被传输窗口截断的 JSON；最终正文仍由结果通道校验。
    }
  }
}
