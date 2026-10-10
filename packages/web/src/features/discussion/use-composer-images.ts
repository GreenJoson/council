/**
 * @input  依赖：React、资产仓储入口 createAssetRepository、桌面桥 chooseImageFile、错误文案、council-asset 协议常量、界面语言
 * @output 导出：useComposerImages —— 编辑器「引用图片」（桌面走原生选择器 + 本机绝对路径入库；浏览器走隐藏 <input type=file> 上传）
 *         与粘贴图片上传；成功后回调插入 `![名称](council-asset:<id>)`，并暴露忙碌/错误状态与 COMPOSER_IMAGE_ACCEPT
 * @pos    Composer 的图片引用副作用集中于此；图片只进 Council 资产库（日志库 assets/），不复制、不移动进项目目录；
 *         本机路径只传给本地 Agent 服务，从不写进消息正文
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useRef, useState, type ChangeEvent, type ClipboardEvent, type RefObject } from "react";
import { createAssetRepository } from "../../data/assets/create-asset-repository";
import { createDesktopBridge } from "../../data/desktop-bridge";
import { getErrorMessage } from "../../data/error-message";
import { COUNCIL_ASSET_SCHEME } from "../../data/markdown-images";
import { useI18n } from "../../i18n/I18nProvider";

/** 浏览器文件选择器的 accept；与服务端资产图片白名单一致。 */
export const COMPOSER_IMAGE_ACCEPT = "image/png,image/jpeg,image/gif,image/webp,image/svg+xml";

export interface UseComposerImagesOptions {
  /** 把 Markdown 图片引用插入草稿（光标处）。 */
  onInsert: (markdown: string) => void;
}

export interface ComposerImagesController {
  isBusy: boolean;
  error: string | null;
  /** 桌面模式用原生选择器，不渲染隐藏文件输入。 */
  isDesktop: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** 点击「引用图片」：桌面打开原生选择器，浏览器打开隐藏文件输入。 */
  pick(): void;
  handleFileInput(event: ChangeEvent<HTMLInputElement>): void;
  handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void;
}

interface InsertedImage {
  assetId: string;
  label: string;
}

/** 用文件名（去扩展名）当说明文字；方括号会破坏 Markdown 图片语法，替换成空格。 */
function imageLabel(name: string, fallback: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  return base.replace(/\.[^.]+$/, "").replace(/[[\]]/g, " ").trim() || fallback;
}

export function useComposerImages({ onInsert }: UseComposerImagesOptions): ComposerImagesController {
  const { t } = useI18n();
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const isDesktop = (import.meta.env.VITE_COUNCIL_DATA_MODE ?? "mock") === "desktop";

  async function run(task: () => Promise<InsertedImage | undefined>): Promise<void> {
    setIsBusy(true);
    setError(null);
    try {
      const inserted = await task();
      if (inserted) {
        onInsert(`![${inserted.label}](${COUNCIL_ASSET_SCHEME}${inserted.assetId})`);
      }
    } catch (cause: unknown) {
      setError(getErrorMessage(cause));
    } finally {
      setIsBusy(false);
    }
  }

  function uploadFile(file: File): void {
    void run(async () => {
      if (!file.type.startsWith("image/")) {
        throw new Error(t("只能引用图片文件"));
      }
      const asset = await createAssetRepository().uploadImage(file);
      return { assetId: asset.id, label: imageLabel(file.name, t("图片")) };
    });
  }

  function pick(): void {
    if (isBusy) {
      return;
    }
    if (!isDesktop) {
      fileInputRef.current?.click();
      return;
    }
    void run(async () => {
      const sourcePath = await createDesktopBridge().chooseImageFile();
      if (!sourcePath) {
        return undefined;
      }
      const asset = await createAssetRepository().ingestLocalFile(sourcePath);
      return { assetId: asset.id, label: imageLabel(sourcePath, t("图片")) };
    });
  }

  function handleFileInput(event: ChangeEvent<HTMLInputElement>): void {
    const file = event.target.files?.[0];
    // 清空后同一文件可再次选择。
    event.target.value = "";
    if (file) {
      uploadFile(file);
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>): void {
    const item = [...event.clipboardData.items]
      .find((candidate) => candidate.kind === "file" && candidate.type.startsWith("image/"));
    const file = item?.getAsFile();
    if (!file) {
      return;
    }
    event.preventDefault();
    uploadFile(file);
  }

  return { isBusy, error, isDesktop, fileInputRef, pick, handleFileInput, handlePaste };
}
