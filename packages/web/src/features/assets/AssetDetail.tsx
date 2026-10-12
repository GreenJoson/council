/**
 * @input  依赖：界面语言、AssetRepository、assetId、内容 revision、AssetsView 读好的资产库序列；use-assets 的 useAssetDetail、
 *         AssetThumbnail、asset-gallery 的翻页适配、components 的 Lightbox、资产文案表与 finalTargets
 * @output 导出：AssetDetail —— #/assets/<assetId>：标题栏位置与上一个/下一个、左栏原图大预览（两侧上一个/下一个箭头，
 *         随视口高度缩放，点击用 Lightbox 看原图，大图里按资产库顺序翻图片，关闭时详情页跟到最后看的那张）、
 *         右栏元数据、挂接列表、设为/取消 final、两步确认删除；大图未打开时 ←/→ 切换上一个/下一个资产
 * @pos    资产库的详情态；读取失败时显示占位与返回链接，不白屏；删除成功后回到 #/assets
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { AlertTriangle, ArrowLeft, ChevronLeft, ChevronRight, ExternalLink, Maximize2, RefreshCw, Star, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { buildHash } from "../../app/routes";
import { Lightbox } from "../../components/Lightbox";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { useI18n } from "../../i18n/I18nProvider";
import type { Asset, AssetLink } from "../../types/assets";
import {
  ASSET_KIND_LABELS,
  ASSET_ROLE_LABELS,
  ASSET_TARGET_LABELS,
  finalTargets,
  formatByteSize,
} from "./asset-labels";
import { buildAssetLightboxNavigation, findAssetNeighbors } from "./asset-gallery";
import { AssetThumbnail } from "./AssetThumbnail";
import { useAssetDetail } from "./use-assets";

export interface AssetDetailProps {
  repository: AssetRepository;
  assetId: string;
  revision: unknown;
  /** 资产库序列（网格「全部」同序）；null 表示还没读到，此时不显示翻页。 */
  sequence: readonly Asset[] | null;
}

const LIST_HASH = buildHash({ view: "assets" });

function linkHref(link: AssetLink): string | undefined {
  // 只有任务有可直达的视图；消息与决策挂接只展示 id。
  return link.targetKind === "work_item" ? buildHash({ view: "tasks", taskId: link.targetId }) : undefined;
}

function assetHref(asset: Asset): string {
  return buildHash({ view: "assets", assetId: asset.id });
}

/** 焦点在输入控件里时方向键是移动光标，不拿来翻页。 */
function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement
    && (target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT");
}

export function AssetDetail({ repository, assetId, revision, sequence }: AssetDetailProps) {
  const { t, locale } = useI18n();
  const state = useAssetDetail(repository, assetId, revision);
  // 大图里正在看的资产 id；null 表示大图未打开。翻页只换这个 id，不改路由，避免详情页重挂载把大图关掉
  const [lightboxAssetId, setLightboxAssetId] = useState<string | null>(null);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const { asset } = state;
  // 详情页上一个/下一个按资产库顺序走，换的是路由；详情页随之重挂载，序列由 AssetsView 保留
  const neighbors = findAssetNeighbors(sequence, assetId);
  const isLightboxOpen = lightboxAssetId !== null;
  const previousId = neighbors?.previous?.id;
  const nextId = neighbors?.next?.id;

  useEffect(() => {
    // 大图打开时 ←/→ 归 Lightbox 翻图
    if (isLightboxOpen) return undefined;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (isTextEntry(event.target)) return;
      const targetId = event.key === "ArrowLeft" ? previousId : event.key === "ArrowRight" ? nextId : undefined;
      if (!targetId) return;
      event.preventDefault();
      window.location.hash = buildHash({ view: "assets", assetId: targetId });
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isLightboxOpen, previousId, nextId]);

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
  // 大图只能翻图片：从资产库序列里挑出读得到原图的图像
  const previewable = (sequence ?? []).filter((item) => item.kind === "image" && repository.contentUrl(item) !== undefined);
  const lightboxAsset = lightboxAssetId === null
    ? undefined
    : previewable.find((item) => item.id === lightboxAssetId) ?? (lightboxAssetId === asset.id ? asset : undefined);
  const lightboxUrl = lightboxAsset ? repository.contentUrl(lightboxAsset) : undefined;

  function closeLightbox() {
    const viewed = lightboxAssetId;
    setLightboxAssetId(null);
    // 在大图里翻到了别的资产：关闭后详情页跟到最后看的那张，元数据与操作对得上眼前的图
    if (viewed && asset && viewed !== asset.id) {
      window.location.hash = buildHash({ view: "assets", assetId: viewed });
    }
  }

  return (
    <main className="assets-view asset-detail" id="main-content" data-asset-id={asset.id}>
      <a className="assets-back-link" href={LIST_HASH}><ArrowLeft size={14} />{t("返回资产库")}</a>
      <header className="asset-detail-header">
        <h1>{t(ASSET_KIND_LABELS[asset.kind])} · <code>{asset.id}</code></h1>
        {asset.deletedAt ? <span className="asset-deleted-pill">{t("已删除")}</span> : null}
        {current.length > 0 ? <span className="asset-final-badge"><Star size={11} />{t("最终稿")}</span> : null}
        {neighbors && neighbors.total > 1 ? (
          <nav className="asset-detail-pager" aria-label={t("资产翻页")}>
            {neighbors.previous ? (
              <a href={assetHref(neighbors.previous)} aria-label={t("上一个资产")} title={t("上一个（←）")}><ChevronLeft size={15} /></a>
            ) : (
              <span className="is-disabled" aria-hidden="true"><ChevronLeft size={15} /></span>
            )}
            <span className="asset-detail-position">
              {t("第 {index} / {total} 个", { index: neighbors.index + 1, total: neighbors.total })}
            </span>
            {neighbors.next ? (
              <a href={assetHref(neighbors.next)} aria-label={t("下一个资产")} title={t("下一个（→）")}><ChevronRight size={15} /></a>
            ) : (
              <span className="is-disabled" aria-hidden="true"><ChevronRight size={15} /></span>
            )}
          </nav>
        ) : null}
      </header>

      {state.loadError ? (
        <p className="asset-notice is-warning" role="alert"><AlertTriangle size={13} />{t(state.loadError)}</p>
      ) : null}
      {state.actionError ? (
        <p className="asset-notice is-danger" role="alert"><AlertTriangle size={13} />{t("操作失败：{message}", { message: t(state.actionError) })}</p>
      ) : null}

      <div className="asset-detail-body">
        <section className="asset-preview" aria-label={t("预览")}>
          <div className="asset-preview-stage">
            {asset.kind === "image" && contentUrl ? (
              <button type="button" className="asset-preview-button" onClick={() => setLightboxAssetId(asset.id)} aria-label={t("查看原图")}>
                <AssetThumbnail repository={repository} asset={asset} className="is-large" source="content" />
                <span className="asset-preview-hint"><Maximize2 size={12} />{t("查看原图")}</span>
              </button>
            ) : (
              <AssetThumbnail repository={repository} asset={asset} className="is-large" />
            )}
            {neighbors?.previous ? (
              <a className="media-nav-button is-previous" href={assetHref(neighbors.previous)} aria-label={t("上一个资产")} title={t("上一个（←）")}>
                <ChevronLeft size={28} />
              </a>
            ) : null}
            {neighbors?.next ? (
              <a className="media-nav-button is-next" href={assetHref(neighbors.next)} aria-label={t("下一个资产")} title={t("下一个（→）")}>
                <ChevronRight size={28} />
              </a>
            ) : null}
          </div>
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

      {lightboxAsset && lightboxUrl ? (
        <Lightbox
          content={{ kind: "image", src: lightboxUrl, alt: lightboxAsset.prompt ?? lightboxAsset.id }}
          onClose={closeLightbox}
          navigation={buildAssetLightboxNavigation(previewable, lightboxAsset.id, (next) => setLightboxAssetId(next.id))}
        />
      ) : null}
    </main>
  );
}
