/**
 * @input  依赖：打开状态、关闭回调和议题创建回调
 * @output 导出：CreateTopicDialog 新建议题表单
 * @pos    Operator Console 的议题创建入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CreateTopicInput } from "../types/council";

export interface CreateTopicDialogProps {
  isOpen: boolean;
  isCreating: boolean;
  onClose: () => void;
  onCreate: (input: CreateTopicInput) => Promise<boolean>;
}

export function CreateTopicDialog({
  isOpen,
  isCreating,
  onClose,
  onCreate,
}: CreateTopicDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [constraints, setConstraints] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (isOpen && !dialog.open) {
      dialog.showModal();
    }
    if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const canCreate = title.trim().length > 0 && question.trim().length > 0 && !isCreating;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    const created = await onCreate({
      title: title.trim(),
      question: question.trim(),
      constraints: constraints
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    });
    if (created) {
      setTitle("");
      setQuestion("");
      setConstraints("");
    }
  }

  return (
    <dialog
      className="create-topic-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-labelledby="create-topic-title"
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <header>
          <div>
            <span className="dialog-kicker">New architecture topic</span>
            <h2 id="create-topic-title">创建一个可验证的议题</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <label>
          <span>议题标题</span>
          <input
            autoFocus
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="例如：订单状态机迁移策略"
          />
        </label>
        <label>
          <span>待解决的问题</span>
          <textarea
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder="写清预期行为、失败条件和需要做出的决定"
            rows={4}
          />
        </label>
        <label>
          <span>约束条件 <small>每行一条，可选</small></span>
          <textarea
            value={constraints}
            onChange={(event) => setConstraints(event.target.value)}
            placeholder={"保持公开接口兼容\n必须支持安全回滚"}
            rows={3}
          />
        </label>
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>取消</button>
          <button className="primary-button" type="submit" disabled={!canCreate}>
            <Plus size={17} />
            {isCreating ? "创建中…" : "创建议题"}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
