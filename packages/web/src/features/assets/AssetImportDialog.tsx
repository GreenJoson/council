/**
 * @input  依赖：界面语言、打开状态、AssetRepository.importAsset
 * @output 导出：AssetImportDialog —— 原生 <dialog> 导入表单，只输入相对项目根目录的路径
 * @pos    资产库的导入入口；项目路径由仓储持有（与任务页同一来源），不在 UI 出现。
 *         成功把资产交给调用方（负责导航到 #/assets/<id>），失败（越界、敏感路径、类型/配额拒绝）留在表单内显示
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { FolderInput, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { getErrorMessage } from "../../data/error-message";
import { useI18n } from "../../i18n/I18nProvider";
import type { Asset } from "../../types/assets";

export interface AssetImportDialogProps {
  isOpen: boolean;
  repository: AssetRepository;
  onClose: () => void;
  onImported: (asset: Asset) => void;
}

export function AssetImportDialog({ isOpen, repository, onClose, onImported }: AssetImportDialogProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [relativePath, setRelativePath] = useState("");
  const [isImporting, setIsImporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      setError(null);
      dialog.showModal();
    }
    if (!isOpen && dialog.open) {
      dialog.close();
    }
  }, [isOpen]);

  const canImport = relativePath.trim().length > 0 && !isImporting;

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canImport) return;
    setIsImporting(true);
    setError(null);
    try {
      const asset = await repository.importAsset(relativePath.trim());
      setRelativePath("");
      onImported(asset);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
    } finally {
      setIsImporting(false);
    }
  }

  return (
    <dialog
      // 复用新建议题对话框的表单骨架
      className="create-topic-dialog asset-import-dialog"
      ref={dialogRef}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClose={onClose}
      aria-labelledby="asset-import-title"
    >
      <form onSubmit={(event) => void handleSubmit(event)}>
        <header>
          <div>
            <span className="dialog-kicker">{t("从项目导入")}</span>
            <h2 id="asset-import-title">{t("把项目目录里的文件加入资产库")}</h2>
          </div>
          <button className="icon-button" type="button" aria-label={t("关闭")} onClick={onClose}>
            <X size={19} />
          </button>
        </header>
        <label>
          <span>{t("相对路径")}</span>
          <input
            autoFocus
            maxLength={1024}
            value={relativePath}
            onChange={(event) => setRelativePath(event.target.value)}
            placeholder="design/mockups/checkout.png"
            spellCheck={false}
          />
          <small>{t("相对当前项目根目录；不能是绝对路径或越出项目目录。同一文件重复导入会返回已有资产。")}</small>
        </label>
        {error ? <p className="asset-notice is-danger" role="alert">{t(error)}</p> : null}
        <footer>
          <button className="secondary-button" type="button" onClick={onClose}>{t("取消")}</button>
          <button className="primary-button" type="submit" disabled={!canImport}>
            <FolderInput size={17} />
            {isImporting ? t("导入中…") : t("导入")}
          </button>
        </footer>
      </form>
    </dialog>
  );
}
