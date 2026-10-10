/**
 * @input  依赖：路由中的可选 assetId、内容 revision（工作区快照对象）；data/assets 的 createAssetRepository，
 *         AssetGrid / AssetDetail / AssetImportDialog
 * @output 导出：AssetsView —— #/assets 与 #/assets/<assetId> 的视图入口
 * @pos    资产功能的装配点：创建一次资产仓储并在网格、详情、导入对话框间共享；导航只写 buildHash 生成的 hash
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import { useMemo, useState } from "react";
import { buildHash } from "../../app/routes";
import { createAssetRepository } from "../../data/assets/create-asset-repository";
import { AssetDetail } from "./AssetDetail";
import { AssetGrid } from "./AssetGrid";
import { AssetImportDialog } from "./AssetImportDialog";

export interface AssetsViewProps {
  assetId?: string;
  /** 内容 revision：资产写入推进内容 revision，传快照对象本身即可。 */
  revision: unknown;
}

export function AssetsView({ assetId, revision }: AssetsViewProps) {
  const repository = useMemo(() => createAssetRepository(), []);
  const [isImportOpen, setIsImportOpen] = useState(false);

  return (
    <>
      {assetId ? (
        <AssetDetail key={assetId} repository={repository} assetId={assetId} revision={revision} />
      ) : (
        <AssetGrid repository={repository} revision={revision} onImport={() => setIsImportOpen(true)} />
      )}
      <AssetImportDialog
        isOpen={isImportOpen}
        repository={repository}
        onClose={() => setIsImportOpen(false)}
        onImported={(asset) => {
          setIsImportOpen(false);
          window.location.hash = buildHash({ view: "assets", assetId: asset.id });
        }}
      />
    </>
  );
}
