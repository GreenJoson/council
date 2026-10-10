/**
 * @input  依赖：界面语言、AssetRepository 的 thumbnailUrl、资产 kind 文案表
 * @output 导出：AssetThumbnail —— 资产缩略图；无缩略图（非图像、地址未知、加载失败/404）时显示按 kind 区分的图标占位
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
}

export function AssetThumbnail({ repository, asset, className }: AssetThumbnailProps) {
  const { t } = useI18n();
  const url = repository.thumbnailUrl(asset);
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
