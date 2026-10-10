/**
 * @input  依赖：界面语言、AssetRepository、assetId、内容 revision；use-assets 的 useAssetDetail、AssetThumbnail、
 *         components 的 Lightbox、资产文案表与 finalTargets
 * @output 导出：AssetDetail —— #/assets/<assetId>：预览（点击用 Lightbox 看原图）、元数据、挂接列表、设为/取消 final、两步确认删除
 * @pos    资产库的详情态；读取失败时显示占位与返回链接，不白屏；删除成功后回到 #/assets
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, ArrowLeft, ExternalLink, Maximize2, RefreshCw, Star, Trash2 } from "lucide-react";
import { useCallback, useState } from "react";
import { buildHash } from "../../app/routes";
import { Lightbox } from "../../components/Lightbox";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { useI18n } from "../../i18n/I18nProvider";
import type { AssetLink } from "../../types/assets";
import {
  ASSET_KIND_LABELS,
  ASSET_ROLE_LABELS,
  ASSET_TARGET_LABELS,
  finalTargets,
  formatByteSize,
} from "./asset-labels";
import { AssetThumbnail } from "./AssetThumbnail";
import { useAssetDetail } from "./use-assets";

export interface AssetDetailProps {
  repository: AssetRepository;
  assetId: string;
  revision: unknown;
}

const LIST_HASH = buildHash({ view: "assets" });

function linkHref(link: AssetLink): string | undefined {
  // 只有任务有可直达的视图；消息与决策挂接只展示 id。
  return link.targetKind === "work_item" ? buildHash({ view: "tasks", taskId: link.targetId }) : undefined;
}

export function AssetDetail({ repository, assetId, revision }: AssetDetailProps) {
  const { t, locale } = useI18n();
  const state = useAssetDetail(repository, assetId, revision);
  const [isLightboxOpen, setIsLightboxOpen] = useState(false);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  // Lightbox 的 effect 依赖 onClose，稳定引用避免每次渲染重设焦点与键盘监听。
  const closeLightbox = useCallback(() => setIsLightboxOpen(false), []);
  const { asset } = state;

  if (!asset) {
    return (
      <main className="assets-view asset-detail" id="main-content">
        <a className="assets-back-link" href={LIST_HASH}><ArrowLeft size={14} />{t("返回资产库")}</a>
        {state.loadError ? (
          <div className="assets-placeholder" role="alert">
            <h1>{t("无法打开这个资产")}</h1>
            <p>{t(state.loadError)}</p>
            <button type="button" onClick={state.reload}><RefreshCw size={13} />{t("重试")}</button>
          </div>
        ) : (
          <p className="assets-placeholder" role="status">{t("加载中…")}</p>
        )}
      </main>
    );
  }

  const contentUrl = asset.deletedAt ? undefined : repository.contentUrl(asset);
  const { pending, current } = finalTargets(asset);
  const canToggleFinal = !asset.deletedAt && (pending.length > 0 || current.length > 0);
  const busy = state.busyAction !== null;
  const created = new Date(asset.createdAt);

  return (
    <main className="assets-view asset-detail" id="main-content" data-asset-id={asset.id}>
      <a className="assets-back-link" href={LIST_HASH}><ArrowLeft size={14} />{t("返回资产库")}</a>
      <header className="asset-detail-header">
        <h1>{t(ASSET_KIND_LABELS[asset.kind])} · <code>{asset.id}</code></h1>
        {asset.deletedAt ? <span className="asset-deleted-pill">{t("已删除")}</span> : null}
        {current.length > 0 ? <span className="asset-final-badge"><Star size={11} />{t("最终稿")}</span> : null}
      </header>

      {state.loadError ? (
        <p className="asset-notice is-warning" role="alert"><AlertTriangle size={13} />{t(state.loadError)}</p>
      ) : null}
      {state.actionError ? (
        <p className="asset-notice is-danger" role="alert"><AlertTriangle size={13} />{t("操作失败：{message}", { message: t(state.actionError) })}</p>
      ) : null}

      <div className="asset-detail-body">
        <section className="asset-preview" aria-label={t("预览")}>
          {asset.kind === "image" && contentUrl ? (
            <button type="button" className="asset-preview-button" onClick={() => setIsLightboxOpen(true)} aria-label={t("查看原图")}>
              <AssetThumbnail repository={repository} asset={asset} className="is-large" />
              <span className="asset-preview-hint"><Maximize2 size={12} />{t("查看原图")}</span>
            </button>
          ) : (
            <AssetThumbnail repository={repository} asset={asset} className="is-large" />
          )}
          {contentUrl && asset.kind !== "image" ? (
            <a className="asset-open-link" href={contentUrl} target="_blank" rel="noreferrer">
              <ExternalLink size={13} />{t("在新标签页打开原文件")}
            </a>
          ) : null}
        </section>

        <section className="asset-meta" aria-labelledby="asset-meta-heading">
          <h2 id="asset-meta-heading">{t("元数据")}</h2>
          <dl>
            <div><dt>{t("类型")}</dt><dd>{t(ASSET_KIND_LABELS[asset.kind])} · {asset.mime}</dd></div>
            <div><dt>{t("大小")}</dt><dd>{formatByteSize(asset.byteSize)}</dd></div>
            {asset.width && asset.height ? (
              <div><dt>{t("尺寸")}</dt><dd>{asset.width}×{asset.height}</dd></div>
            ) : null}
            <div><dt>{t("入库时间")}</dt><dd>{Number.isNaN(created.getTime()) ? asset.createdAt : created.toLocaleString(locale)}</dd></div>
            {asset.origin.actorId ? <div><dt>{t("生成者")}</dt><dd>{asset.origin.actorId}</dd></div> : null}
            {asset.origin.delegationId ? <div><dt>{t("来源委派")}</dt><dd><code>{asset.origin.delegationId}</code></dd></div> : null}
            <div><dt>SHA-256</dt><dd><code className="asset-sha">{asset.sha256}</code></dd></div>
            {asset.prompt ? <div><dt>{t("提示词")}</dt><dd className="asset-prompt">{asset.prompt}</dd></div> : null}
          </dl>

          <h2 id="asset-links-heading">{t("挂接")}</h2>
          {asset.links.length === 0 ? (
            <p className="asset-muted">{t("没有挂到任何任务、消息或决策。")}</p>
          ) : (
            <ul className="asset-links" aria-labelledby="asset-links-heading">
              {asset.links.map((link) => {
                const href = linkHref(link);
                return (
                  <li key={`${link.targetKind}:${link.targetId}:${link.role}`}>
                    <span className={`asset-role-pill is-${link.role}`}>{t(ASSET_ROLE_LABELS[link.role])}</span>
                    <span>{t(ASSET_TARGET_LABELS[link.targetKind])}</span>
                    {href ? <a href={href}><code>{link.targetId}</code></a> : <code>{link.targetId}</code>}
                  </li>
                );
              })}
            </ul>
          )}

          {!asset.deletedAt ? (
            <div className="asset-actions">
              <button
                type="button"
                disabled={!canToggleFinal || busy}
                title={canToggleFinal ? undefined : t("只有挂为任务产物的资产才能设为最终稿")}
                onClick={() => void state.toggleFinal()}
              >
                <Star size={13} />
                {state.busyAction === "final" ? t("保存中…") : pending.length === 0 && current.length > 0 ? t("取消最终稿") : t("设为最终稿")}
              </button>
              {isConfirmingDelete ? (
                <span className="asset-confirm">
                  <span>{t("删除后原文件与缩略图都不可再读取，确定吗？")}</span>
                  <button
                    type="button"
                    className="danger-button"
                    disabled={busy}
                    onClick={() => {
                      void state.remove().then((removed) => {
                        if (removed) window.location.hash = LIST_HASH;
                      });
                    }}
                  >
                    {state.busyAction === "delete" ? t("删除中…") : t("确认删除")}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setIsConfirmingDelete(false)}>{t("取消")}</button>
                </span>
              ) : (
                <button type="button" disabled={busy} onClick={() => setIsConfirmingDelete(true)}>
                  <Trash2 size={13} />{t("删除")}
                </button>
              )}
            </div>
          ) : null}
        </section>
      </div>

      {isLightboxOpen && contentUrl ? (
        <Lightbox content={{ kind: "image", src: contentUrl, alt: asset.prompt ?? asset.id }} onClose={closeLightbox} />
      ) : null}
    </main>
  );
}
