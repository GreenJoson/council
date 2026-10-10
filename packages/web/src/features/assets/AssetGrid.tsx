/**
 * @input  依赖：界面语言、AssetRepository、内容 revision、导入入口回调；use-assets 的 useAssetPage、AssetThumbnail、kind 文案表
 * @output 导出：AssetGrid —— #/assets 列表态：kind 筛选、缩略图网格（卡片链接到 #/assets/<id>）、上一页/下一页分页
 * @pos    资产库的网格视图；页大小取仓储的 pageSize（VITE_COUNCIL_ASSET_PAGE_SIZE），筛选变化时回到第一页
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { ChevronLeft, ChevronRight, FolderInput, RefreshCw, Star } from "lucide-react";
import { useState } from "react";
import { buildHash } from "../../app/routes";
import type { AssetRepository } from "../../data/assets/asset-repository";
import { useI18n } from "../../i18n/I18nProvider";
import { ASSET_KINDS, type AssetKind } from "../../types/assets";
import { ASSET_KIND_LABELS, formatByteSize } from "./asset-labels";
import { AssetThumbnail } from "./AssetThumbnail";
import { useAssetPage } from "./use-assets";

export interface AssetGridProps {
  repository: AssetRepository;
  revision: unknown;
  onImport: () => void;
}

export function AssetGrid({ repository, revision, onImport }: AssetGridProps) {
  const { t } = useI18n();
  const [kind, setKind] = useState<AssetKind | "">("");
  const [offset, setOffset] = useState(0);
  const { page, isLoading, error, reload } = useAssetPage(repository, kind, offset, revision);
  const items = page?.items ?? [];
  const pageSize = repository.pageSize;
  const pageNumber = Math.floor(offset / pageSize) + 1;
  const pageCount = page ? Math.max(1, Math.ceil(page.total / pageSize)) : 1;

  return (
    <main className="assets-view" id="main-content">
      <header className="assets-view-header">
        <h1>{t("资产库")}</h1>
        <div className="assets-view-actions">
          <button type="button" disabled={isLoading} onClick={reload}><RefreshCw size={13} />{t("刷新")}</button>
          <button className="primary-button" type="button" onClick={onImport}><FolderInput size={15} />{t("从项目导入")}</button>
        </div>
      </header>
      <div className="assets-filters">
        <label>
          <span>{t("资产类型")}</span>
          <select
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as AssetKind | "");
              setOffset(0);
            }}
          >
            <option value="">{t("全部")}</option>
            {ASSET_KINDS.map((value) => <option key={value} value={value}>{t(ASSET_KIND_LABELS[value])}</option>)}
          </select>
        </label>
        {page ? <span className="assets-count">{t("共 {total} 个", { total: page.total })}</span> : null}
      </div>

      {error ? (
        <p className="asset-notice is-danger" role="alert">{t(error)}</p>
      ) : isLoading && !page ? (
        <p className="assets-placeholder" role="status">{t("加载中…")}</p>
      ) : items.length === 0 ? (
        <p className="assets-placeholder">{kind ? t("没有这一类型的资产。") : t("资产库还是空的。图像委派的产物会自动入库，也可以从项目目录导入。")}</p>
      ) : (
        <ul className="asset-grid" aria-label={t("资产列表")}>
          {items.map((asset) => {
            const isFinal = asset.links.some((link) => link.role === "final");
            return (
              <li key={asset.id}>
                <a className="asset-card" href={buildHash({ view: "assets", assetId: asset.id })} data-asset-id={asset.id}>
                  <AssetThumbnail repository={repository} asset={asset} />
                  <span className="asset-card-meta">
                    <strong>{t(ASSET_KIND_LABELS[asset.kind])}</strong>
                    <span>
                      {asset.width && asset.height ? `${String(asset.width)}×${String(asset.height)} · ` : ""}
                      {formatByteSize(asset.byteSize)}
                    </span>
                  </span>
                  {isFinal ? <span className="asset-final-badge"><Star size={11} />{t("最终稿")}</span> : null}
                </a>
              </li>
            );
          })}
        </ul>
      )}

      {page && page.total > pageSize ? (
        <nav className="asset-pagination" aria-label={t("资产分页")}>
          <button type="button" disabled={offset === 0 || isLoading} onClick={() => setOffset(Math.max(0, offset - pageSize))}>
            <ChevronLeft size={14} />{t("上一页")}
          </button>
          <span>{t("第 {page} / {count} 页", { page: pageNumber, count: pageCount })}</span>
          <button type="button" disabled={!page.hasMore || isLoading} onClick={() => setOffset(offset + pageSize)}>
            {t("下一页")}<ChevronRight size={14} />
          </button>
        </nav>
      ) : null}
    </main>
  );
}
