/**
 * @input  依赖：Agent 运行标识、公开文本增量与预览长度上限
 * @output 导出：进程内 Agent 草稿快照、增量事件与订阅中心
 * @pos    CLI 运行时和 HTTP SSE 之间的临时桥梁；草稿不写 SQLite
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

export type AgentProgressOperation =
  | "snapshot"
  | "reset"
  | "append"
  | "replace"
  | "complete";

export interface AgentProgressMeta {
  runId: string;
  topicId: string;
  adapterId: string;
}

export interface AgentProgressEvent extends AgentProgressMeta {
  sequence: number;
  operation: AgentProgressOperation;
  content?: string;
}

export type AgentProgressListener = (event: AgentProgressEvent) => void;

interface AgentProgressDraft extends AgentProgressMeta {
  sequence: number;
  content: string;
}

export interface AgentProgressPublisher {
  reset(meta: AgentProgressMeta): void;
  append(meta: AgentProgressMeta, delta: string): void;
  replace(meta: AgentProgressMeta, content: string): void;
  complete(meta: AgentProgressMeta): void;
}

function sameInvocation(draft: AgentProgressDraft, meta: AgentProgressMeta): boolean {
  return draft.topicId === meta.topicId && draft.adapterId === meta.adapterId;
}

export class AgentProgressHub implements AgentProgressPublisher {
  readonly #drafts = new Map<string, AgentProgressDraft>();
  readonly #listeners = new Set<AgentProgressListener>();

  constructor(private readonly maxContentChars: number) {
    if (!Number.isSafeInteger(maxContentChars) || maxContentChars <= 0) {
      throw new Error("Agent 草稿预览长度上限必须是正安全整数。");
    }
  }

  reset(meta: AgentProgressMeta): void {
    const previous = this.#drafts.get(meta.runId);
    const draft: AgentProgressDraft = {
      ...meta,
      sequence: (previous?.sequence ?? 0) + 1,
      content: "",
    };
    this.#drafts.set(meta.runId, draft);
    this.#emit({ ...draft, operation: "reset" });
  }

  append(meta: AgentProgressMeta, delta: string): void {
    if (!delta) {
      return;
    }
    const previous = this.#drafts.get(meta.runId);
    const base = previous && sameInvocation(previous, meta)
      ? previous
      : { ...meta, sequence: 0, content: "" };
    const available = Math.max(0, this.maxContentChars - base.content.length);
    const visibleDelta = delta.slice(0, available);
    if (!visibleDelta) {
      return;
    }
    const draft: AgentProgressDraft = {
      ...meta,
      sequence: base.sequence + 1,
      content: base.content + visibleDelta,
    };
    this.#drafts.set(meta.runId, draft);
    this.#emit({
      ...meta,
      sequence: draft.sequence,
      operation: "append",
      content: visibleDelta,
    });
  }

  replace(meta: AgentProgressMeta, content: string): void {
    const normalized = content.slice(0, this.maxContentChars);
    const previous = this.#drafts.get(meta.runId);
    const draft: AgentProgressDraft = {
      ...meta,
      sequence: (previous?.sequence ?? 0) + 1,
      content: normalized,
    };
    this.#drafts.set(meta.runId, draft);
    this.#emit({ ...draft, operation: "replace" });
  }

  complete(meta: AgentProgressMeta): void {
    const previous = this.#drafts.get(meta.runId);
    this.#drafts.delete(meta.runId);
    this.#emit({
      ...meta,
      sequence: (previous?.sequence ?? 0) + 1,
      operation: "complete",
    });
  }

  snapshots(): AgentProgressEvent[] {
    return [...this.#drafts.values()].map((draft) => ({
      ...draft,
      operation: "snapshot",
    }));
  }

  subscribe(listener: AgentProgressListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  #emit(event: AgentProgressEvent): void {
    for (const listener of this.#listeners) {
      listener({ ...event });
    }
  }
}
