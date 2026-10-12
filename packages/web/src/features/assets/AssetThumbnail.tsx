/**
 * @input  依赖：界面语言、AssetRepository 的 thumbnailUrl / contentUrl、资产 kind 文案表
 * @output 导出：AssetThumbnail —— 资产缩略图；source="content" 时改读原图（详情大预览用，缩略图最长边只有 512 会糊）；
 *         无可用地址（非图像、地址未知、加载失败/404）时显示按 kind 区分的图标占位
 * @pos    资产网格、资产详情与任务产物区共用的最小展示单元；不发请求，只把仓储给出的 URL 交给 <img>
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { Box, FileArchive, FileText, ImageOff } from "lucide-react";
import { useState, type ComponentType } from "react";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { useI18n } from "../../i18n/I18nProvider";
import type { Asset, AssetKind } from "../../types/assets";
import { ASSET_KIND_LABELS } from "./asset-labels";

const PLACEHOLDER_ICONS: Record<AssetKind, ComponentType<{ size?: number }>> = {
  image: ImageOff,
  model3d: Box,
  document: FileText,
  archive: FileArchive,
};

export interface AssetThumbnailProps {
  repository: AssetRepository;
  asset: Asset;
  className?: string;
  /** 默认读缩略图；大尺寸预览传 "content" 读原图。非图像资产两者都只显示占位。 */
  source?: "thumbnail" | "content";
}

export function AssetThumbnail({ repository, asset, className, source = "thumbnail" }: AssetThumbnailProps) {
  const { t } = useI18n();
  const url = source === "content"
    ? (asset.kind === "image" ? repository.contentUrl(asset) : undefined)
    : repository.thumbnailUrl(asset);
  // 记住失败的是哪个 URL：URL 变化（如桌面模式拿到服务地址）时自动再试一次。
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const classes = ["asset-thumbnail", className].filter(Boolean).join(" ");

  if (!url || failedUrl === url) {
    const Icon = PLACEHOLDER_ICONS[asset.kind];
    return (
      <span className={`${classes} is-placeholder`} role="img" aria-label={t(ASSET_KIND_LABELS[asset.kind])}>
        <Icon size={28} />
        <small>{asset.mime}</small>
      </span>
    );
  }
  return (
    <span className={classes}>
      <img src={url} alt={asset.prompt ?? asset.id} loading="lazy" onError={() => setFailedUrl(url)} />
    </span>
  );
}
