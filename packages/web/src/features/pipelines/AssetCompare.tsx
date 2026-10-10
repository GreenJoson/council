/**
 * @input  依赖：界面语言、AssetRepository（getAsset/contentUrl）、候选资产 id、已勾选 id 与切换回调；
 *         features/assets 的 AssetThumbnail，components 的 Lightbox
 * @output 导出：AssetCompare —— select 阶段的并排对比：候选图 2 或 3 列（窄屏单列），点击看原图，勾选 1–maxSelected 张作为最终稿
 * @pos    StageControls 的子区块；只负责展示与勾选状态回传，提交「选定」由调用方完成。
 *         资产元数据逐个 getAsset 读取，单张读失败只影响该卡片（显示 id 占位），不拖垮整组
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useCallback, useEffect, useState } from "react";
import { Lightbox } from "../../components/Lightbox";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { useI18n } from "../../i18n/I18nProvider";
import type { Asset } from "../../types/assets";
import { AssetThumbnail } from "../assets/AssetThumbnail";

export interface AssetCompareProps {
  repository: AssetRepository;
  assetIds: string[];
  selected: string[];
  maxSelected: number;
  disabled: boolean;
  onToggle: (assetId: string, checked: boolean) => void;
}

function useCompareAssets(repository: AssetRepository, assetIds: string[]) {
  const [assets, setAssets] = useState<Map<string, Asset>>(new Map());
  const key = assetIds.join(",");
  useEffect(() => {
    let active = true;
    void Promise.allSettled(key.split(",").filter(Boolean).map((id) => repository.getAsset(id)))
      .then((results) => {
        if (!active) return;
        const next = new Map<string, Asset>();
        for (const result of results) {
          if (result.status === "fulfilled") next.set(result.value.id, result.value);
        }
        setAssets(next);
      });
    return () => { active = false; };
  }, [repository, key]);
  return assets;
}

export function AssetCompare({ repository, assetIds, selected, maxSelected, disabled, onToggle }: AssetCompareProps) {
  const { t } = useI18n();
  const assets = useCompareAssets(repository, assetIds);
  const [preview, setPreview] = useState<Asset | null>(null);
  const closePreview = useCallback(() => setPreview(null), []);
  // 2 张并排两列，3 张及以上三列；具体断点由 pipelines.css 按 data-columns 处理。
  const columns = assetIds.length >= 3 ? 3 : 2;
  const previewUrl = preview ? repository.contentUrl(preview) : undefined;

  if (assetIds.length === 0) {
    return <p className="task-muted">{t("本流水线还没有可挑选的产出图。")}</p>;
  }

  return (
    <>
      <div className="pipeline-compare" data-columns={columns}>
        {assetIds.map((assetId) => {
          const asset = assets.get(assetId);
          const checked = selected.includes(assetId);
          const canPreview = asset !== undefined && repository.contentUrl(asset) !== undefined;
          return (
            <figure className={`pipeline-compare-card ${checked ? "is-selected" : ""}`} key={assetId} data-asset-id={assetId}>
              {asset ? (
                <button
                  className="pipeline-compare-preview"
                  type="button"
                  disabled={!canPreview}
                  aria-label={t("查看原图 {id}", { id: assetId.slice(-8) })}
                  onClick={() => setPreview(asset)}
                >
                  <AssetThumbnail repository={repository} asset={asset} />
                </button>
              ) : (
                <div className="pipeline-compare-missing">{t("资产不可读")}</div>
              )}
              <figcaption>
                <label>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={disabled || (!checked && selected.length >= maxSelected)}
                    onChange={(event) => onToggle(assetId, event.target.checked)}
                  />
                  <span>{t("选为最终稿")}</span>
                </label>
                <code>{assetId.slice(-8)}</code>
              </figcaption>
            </figure>
          );
        })}
      </div>
      {preview && previewUrl ? (
        <Lightbox content={{ kind: "image", src: previewUrl, alt: preview.prompt ?? preview.id }} onClose={closePreview} />
      ) : null}
    </>
  );
}
