/**
 * @input  依赖：types/assets 的资产 DTO、查询与挂接类型
 * @output 导出：AssetRepository 资产列表/详情/导入/浏览器图片上传/本机图片入库/挂接/解除挂接/软删除与缩略图/原文 URL 契约
 * @pos    资产领域的前端数据边界；http/desktop/mock 三套实现由 create-asset-repository.ts 选择
 *
 * 刷新约定：与 TaskRepository 相同，刻意不提供 subscribe。资产写入推进内容 revision
 * （沿用 council.changed），调用方在 workspace 快照变化时重读即可；自身写操作返回最新资产，
 * 调用方据此就地更新。
 *
 * URL 约定：thumbnailUrl/contentUrl 是同步纯函数，只拼地址不发请求，供 <img src> 直接使用；
 * 返回 undefined 表示当前无法给出地址（非图像没有缩略图、桌面模式尚未拿到服务地址）。
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type {
  Asset,
  AssetLinkTarget,
  AssetListQuery,
  AssetPage,
} from "../../types/assets";

export interface AssetRepository {
  /** 网格每页条数，来自 VITE_COUNCIL_ASSET_PAGE_SIZE。 */
  readonly pageSize: number;
  /** 当前项目的资产，按 createdAt 降序，默认不含已删除。 */
  listAssets(query?: AssetListQuery): Promise<AssetPage>;
  getAsset(assetId: string): Promise<Asset>;
  /** 从当前项目目录导入；relativePath 相对项目根。同 sha256 时返回既有资产。 */
  importAsset(relativePath: string): Promise<Asset>;
  /** 浏览器选择/粘贴的图片字节入库（只进资产库，不写项目目录）；同内容返回既有资产。 */
  uploadImage(file: File): Promise<Asset>;
  /** 桌面壳：按原生选择器给出的绝对路径把本机图片读入资产库，原文件不复制不移动；浏览器/mock 实现抛诚实指引。 */
  ingestLocalFile(sourcePath: string): Promise<Asset>;
  /** 挂接后返回最新资产（含新 links）。 */
  addLink(assetId: string, link: AssetLinkTarget): Promise<Asset>;
  removeLink(assetId: string, link: AssetLinkTarget): Promise<Asset>;
  /** 软删除；之后 content/thumbnail 不可读。 */
  deleteAsset(assetId: string): Promise<void>;
  thumbnailUrl(asset: Asset): string | undefined;
  contentUrl(asset: Asset): string | undefined;
}
