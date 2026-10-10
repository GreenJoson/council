/**
 * @input  依赖：界面语言、AssetRepository、taskId、两路 revision；features/assets 的 AssetThumbnail，components 的 Lightbox
 * @output 导出：TaskAssetsSection —— 任务详情的「产物」区：挂在本任务上的 output/final 资产缩略图网格，
 *         点击用 Lightbox 看原图，逐张设为/取消最终稿，卡片链接到 #/assets/<id>
 * @pos    任务详情的子区块；按 target=work_item:<taskId> 查询资产，revision 或编排 revision 前进时重读
 *         （图像委派完成入库会推进它们）；设 final 只增删本任务的 final 挂接，不碰其它任务
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, RefreshCw, Star } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { buildHash } from "../../app/routes";
import { Lightbox } from "../../components/Lightbox";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { getErrorMessage } from "../../data/error-message";
import { useI18n } from "../../i18n/I18nProvider";
import type { Asset } from "../../types/assets";
import { AssetThumbnail } from "../assets/AssetThumbnail";

export interface TaskAssetsSectionProps {
  repository: AssetRepository;
  taskId: string;
  revision: unknown;
  executionRevision: unknown;
}

function hasRole(asset: Asset, taskId: string, role: "output" | "final"): boolean {
  return asset.links.some((link) => link.targetKind === "work_item" && link.targetId === taskId && link.role === role);
}

export function TaskAssetsSection({ repository, taskId, revision, executionRevision }: TaskAssetsSectionProps) {
  const { t } = useI18n();
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [preview, setPreview] = useState<Asset | null>(null);
  const [retry, setRetry] = useState(0);
  const closePreview = useCallback(() => setPreview(null), []);

  useEffect(() => {
    let active = true;
    repository.listAssets({ target: { targetKind: "work_item", targetId: taskId }, limit: repository.pageSize, offset: 0 })
      .then((page) => {
        if (!active) return;
        setAssets(page.items.filter((asset) => !asset.deletedAt
          && (hasRole(asset, taskId, "output") || hasRole(asset, taskId, "final"))));
        setError(null);
      })
      .catch((reason: unknown) => { if (active) setError(getErrorMessage(reason)); });
    return () => { active = false; };
  }, [repository, taskId, revision, executionRevision, retry]);

  async function toggleFinal(asset: Asset) {
    setBusyId(asset.id);
    setError(null);
    try {
      const link = { targetKind: "work_item" as const, targetId: taskId, role: "final" as const };
      const updated = hasRole(asset, taskId, "final")
        ? await repository.removeLink(asset.id, link)
        : await repository.addLink(asset.id, link);
      setAssets((current) => current?.map((entry) => entry.id === updated.id ? updated : entry) ?? current);
    } catch (reason: unknown) {
      setError(getErrorMessage(reason));
      setRetry((value) => value + 1);
    } finally {
      setBusyId(null);
    }
  }

  const previewUrl = preview ? repository.contentUrl(preview) : undefined;

  return (
    <section className="task-detail-section task-assets" aria-labelledby="task-assets-heading">
      <h2 id="task-assets-heading">{t("产物")}</h2>
      {error ? (
        <p className="task-notice is-danger" role="alert">
          <AlertTriangle size={13} />{t(error)}
          <button type="button" className="work-item-mini-button" onClick={() => setRetry((value) => value + 1)}><RefreshCw size={12} />{t("重试")}</button>
        </p>
      ) : null}
      {assets === null ? (
        error ? null : <p className="task-muted" role="status">{t("加载中…")}</p>
      ) : assets.length === 0 ? (
        <p className="task-muted">{t("还没有产物。图像委派完成后，生成的图片会出现在这里。")}</p>
      ) : (
        <ul className="task-assets-grid" aria-label={t("任务产物")}>
          {assets.map((asset) => {
            const isFinal = hasRole(asset, taskId, "final");
            const canPreview = asset.kind === "image" && repository.contentUrl(asset) !== undefined;
            return (
              <li key={asset.id} className={`task-assets-item${isFinal ? " is-final" : ""}`} data-asset-id={asset.id}>
                {canPreview ? (
                  <button type="button" aria-label={t("查看原图")} onClick={() => setPreview(asset)}>
                    <AssetThumbnail repository={repository} asset={asset} />
                  </button>
                ) : (
                  <AssetThumbnail repository={repository} asset={asset} />
                )}
                <div className="task-assets-caption">
                  <a href={buildHash({ view: "assets", assetId: asset.id })}>{asset.id.slice(-8)}</a>
                  {isFinal ? <span className="asset-final-badge"><Star size={11} />{t("最终稿")}</span> : null}
                </div>
                <div className="task-assets-actions">
                  <button type="button" disabled={busyId !== null} onClick={() => void toggleFinal(asset)}>
                    <Star size={11} />
                    {busyId === asset.id ? t("保存中…") : isFinal ? t("取消最终稿") : t("设为最终稿")}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {preview && previewUrl ? (
        <Lightbox content={{ kind: "image", src: previewUrl, alt: preview.prompt ?? preview.id }} onClose={closePreview} />
      ) : null}
    </section>
  );
}
