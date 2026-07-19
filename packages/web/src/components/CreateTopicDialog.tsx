/**
 * @input  依赖：打开状态、桌面项目设置、目录浏览与议题创建回调
 * @output 导出：CreateTopicDialog 新建议题表单（含目标项目选择）
 * @pos    Operator Console 的议题创建入口
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Plus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { DesktopSettings } from "../data/desktop-bridge";
import type { CreateTopicInput } from "../types/council";

const BROWSE_OPTION_VALUE = "__browse__";

function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

export interface CreateTopicDialogProps {
  isOpen: boolean;
  isCreating: boolean;
  onClose: () => void;
  onCreate: (input: CreateTopicInput, targetProjectPath?: string) => Promise<boolean>;
  /** 桌面端才有：提供当前/最近项目，让议题在创建时选择落点 */
  desktopSettings?: DesktopSettings;
  isBrowsingProject?: boolean;
  onBrowseProject?: () => Promise<void>;
}

export function CreateTopicDialog({
  isOpen,
  isCreating,
  onClose,
  onCreate,
  desktopSettings,
  isBrowsingProject,
  onBrowseProject,
}: CreateTopicDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState("");
  const [question, setQuestion] = useState("");
  const [constraints, setConstraints] = useState("");
  // null 表示跟随当前项目；浏览新目录会改变当前项目，因此保持跟随即可
  const [targetProjectPath, setTargetProjectPath] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) {
      return;
    }
    if (isOpen && !dialog.open) {
      setTargetProjectPath(null);
      dialog.showModal();
    }
    if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const currentProjectPath = desktopSettings?.currentProjectPath ?? null;
  const selectablePaths = currentProjectPath
    ? [
        currentProjectPath,
        ...(desktopSettings?.recentProjectPaths ?? []).filter(
          (path) => path !== currentProjectPath,
        ),
      ]
    : [];
  const effectiveProjectPath =
    targetProjectPath && selectablePaths.includes(targetProjectPath)
      ? targetProjectPath
      : currentProjectPath;

  const canCreate = title.trim().length > 0 && question.trim().length > 0 && !isCreating;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canCreate) {
      return;
    }
    const created = await onCreate(
      {
        title: title.trim(),
        question: question.trim(),
        constraints: constraints
          .split("\n")
          .map((item) => item.trim())
          .filter(Boolean),
      },
      effectiveProjectPath ?? undefined,
    );
    if (created) {
      setTitle("");
      setQuestion("");
      setConstraints("");
      setTargetProjectPath(null);
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
            <span className="dialog-kicker">新建架构议题</span>
            <h2 id="create-topic-title">创建一个可验证的议题</h2>
          </div>
          <button className="icon-button" type="button" aria-label="关闭" onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        {currentProjectPath ? (
          <label>
            <span>目标项目 <small>议题将写入该项目的共享讨论</small></span>
            <select
              value={effectiveProjectPath ?? ""}
              disabled={isCreating || Boolean(isBrowsingProject)}
              onChange={(event) => {
                if (event.target.value === BROWSE_OPTION_VALUE) {
                  void onBrowseProject?.().then(() => setTargetProjectPath(null));
                  return;
                }
                setTargetProjectPath(event.target.value);
              }}
            >
              {selectablePaths.map((path) => (
                <option key={path} value={path}>
                  {pathBasename(path)} — {path}
                </option>
              ))}
              {onBrowseProject ? (
                <option value={BROWSE_OPTION_VALUE}>
                  {isBrowsingProject ? "正在打开目录选择…" : "浏览其他目录…"}
                </option>
              ) : null}
            </select>
          </label>
        ) : null}
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
