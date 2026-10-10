/**
 * @input  依赖：types/assets 的资产 DTO
 * @output 导出：createMockAssetFixtures()（深拷贝的资产夹具 + 每个资产的内联图像 data URI）、
 *         mockPlaceholderImage()（导入时生成占位图）、mockSha256()（由种子生成格式合法的伪 sha256）
 * @pos    资产库与任务产物区的脱敏 mock 数据源：4 张挂在「结算页空状态插画」任务上的图
 *         （3 张 output，其中 1 张同时是 final；1 张 reference），1 张未挂接的导入图，1 份 PDF 文档。
 *         图像全部是内联 SVG data URI，不依赖网络与真实文件
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { Asset } from "../../types/assets";

/** 与 mock-tasks 里的 image 任务同 id，任务详情的产物区据此读到夹具。 */
const EMPTY_STATE_TASK_ID = "work_item_task_empty_state_art";
const RESEARCH_TASK_ID = "work_item_task_reconcile_research";

export interface MockAssetFixtures {
  assets: Asset[];
  /** assetId → 内联图像；没有条目的资产（如 PDF）无法预览。 */
  images: Record<string, string>;
}

function svgDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** 空状态插画：一个托盘 + 若干漂浮的票据，按配色区分浅/深/单色。 */
function emptyStateArt(background: string, stroke: string, accent: string): string {
  return svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480" viewBox="0 0 640 480">
<rect width="640" height="480" fill="${background}"/>
<rect x="190" y="290" width="260" height="80" rx="16" fill="none" stroke="${stroke}" stroke-width="6"/>
<path d="M210 290 L250 230 H390 L430 290" fill="none" stroke="${stroke}" stroke-width="6" stroke-linejoin="round"/>
<rect x="270" y="120" width="100" height="130" rx="10" fill="${accent}" stroke="${stroke}" stroke-width="5" transform="rotate(-8 320 185)"/>
<line x1="290" y1="160" x2="350" y2="152" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>
<line x1="292" y1="185" x2="342" y2="178" stroke="${stroke}" stroke-width="5" stroke-linecap="round"/>
<circle cx="170" cy="150" r="10" fill="${accent}"/><circle cx="480" cy="200" r="14" fill="none" stroke="${accent}" stroke-width="5"/>
</svg>`);
}

function iconArt(): string {
  return svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
<rect x="56" y="72" width="144" height="112" rx="18" fill="none" stroke="#3b6fe0" stroke-width="12"/>
<path d="M56 110 H200" stroke="#3b6fe0" stroke-width="12"/>
<circle cx="168" cy="150" r="12" fill="#f0a020"/>
</svg>`);
}

function paletteArt(): string {
  const swatches = ["#1f2a44", "#3b6fe0", "#7fb4ff", "#f0a020", "#f6f3ec"];
  const rects = swatches
    .map((color, index) => `<rect x="${String(index * 128)}" y="0" width="128" height="360" fill="${color}"/>`)
    .join("");
  return svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360" viewBox="0 0 640 360">${rects}</svg>`);
}

function wireframeArt(): string {
  return svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="390" height="844" viewBox="0 0 390 844">
<rect width="390" height="844" fill="#f4f5f7"/>
<rect x="20" y="60" width="350" height="56" rx="10" fill="#ffffff" stroke="#c9ced6" stroke-width="2"/>
<rect x="20" y="140" width="350" height="220" rx="12" fill="#ffffff" stroke="#c9ced6" stroke-width="2"/>
<rect x="20" y="384" width="168" height="120" rx="12" fill="#ffffff" stroke="#c9ced6" stroke-width="2"/>
<rect x="202" y="384" width="168" height="120" rx="12" fill="#ffffff" stroke="#c9ced6" stroke-width="2"/>
<rect x="20" y="760" width="350" height="56" rx="28" fill="#3b6fe0"/>
</svg>`);
}

/** 导入时的占位图：按文件名生成一张带标签的卡片，模拟服务端缩略图。 */
export function mockPlaceholderImage(label: string): string {
  const safe = label.replace(/[<>&"']/g, "");
  return svgDataUri(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320" viewBox="0 0 480 320">
<rect width="480" height="320" fill="#e8ecf3"/>
<rect x="24" y="24" width="432" height="272" rx="16" fill="none" stroke="#9aa6b8" stroke-width="4" stroke-dasharray="12 10"/>
<text x="240" y="170" font-family="sans-serif" font-size="22" fill="#4a5566" text-anchor="middle">${safe}</text>
</svg>`);
}

/** 伪造但格式合法的 sha256：64 位十六进制，由种子重复得到。 */
export function mockSha256(seed: string): string {
  let hash = 0;
  for (const char of seed) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(16).padStart(8, "0").repeat(8);
}

const ASSETS: Asset[] = [
  {
    id: "asset_mock_empty_light",
    kind: "image",
    mime: "image/png",
    byteSize: 182_344,
    sha256: mockSha256("empty-light"),
    width: 640,
    height: 480,
    prompt: "扁平线稿风格的空托盘与漂浮票据，浅色背景，不出现文字",
    origin: { delegationId: "delegation_mock_empty_state_art", actorId: "codex" },
    createdAt: "2026-10-09T04:10:00.000Z",
    links: [
      { targetKind: "work_item", targetId: EMPTY_STATE_TASK_ID, role: "output", createdAt: "2026-10-09T04:10:00.000Z" },
      { targetKind: "work_item", targetId: EMPTY_STATE_TASK_ID, role: "final", createdAt: "2026-10-09T05:00:00.000Z" },
    ],
  },
  {
    id: "asset_mock_empty_dark",
    kind: "image",
    mime: "image/png",
    byteSize: 175_902,
    sha256: mockSha256("empty-dark"),
    width: 640,
    height: 480,
    prompt: "同一构图的深色主题版本，线条使用浅色",
    origin: { delegationId: "delegation_mock_empty_state_art", actorId: "codex" },
    createdAt: "2026-10-09T04:11:00.000Z",
    links: [
      { targetKind: "work_item", targetId: EMPTY_STATE_TASK_ID, role: "output", createdAt: "2026-10-09T04:11:00.000Z" },
    ],
  },
  {
    id: "asset_mock_empty_icon",
    kind: "image",
    mime: "image/png",
    byteSize: 12_480,
    sha256: mockSha256("empty-icon"),
    width: 256,
    height: 256,
    prompt: "透明背景的钱包小图标，与插画同一配色",
    origin: { delegationId: "delegation_mock_empty_state_art", actorId: "codex" },
    createdAt: "2026-10-09T04:12:00.000Z",
    links: [
      { targetKind: "work_item", targetId: EMPTY_STATE_TASK_ID, role: "output", createdAt: "2026-10-09T04:12:00.000Z" },
    ],
  },
  {
    id: "asset_mock_brand_palette",
    kind: "image",
    mime: "image/png",
    byteSize: 8_210,
    sha256: mockSha256("brand-palette"),
    width: 640,
    height: 360,
    origin: {},
    createdAt: "2026-10-08T09:00:00.000Z",
    links: [
      { targetKind: "work_item", targetId: EMPTY_STATE_TASK_ID, role: "reference", createdAt: "2026-10-09T03:00:00.000Z" },
    ],
  },
  {
    id: "asset_mock_checkout_wireframe",
    kind: "image",
    mime: "image/svg+xml",
    byteSize: 1_964,
    sha256: mockSha256("checkout-wireframe"),
    width: 390,
    height: 844,
    origin: {},
    createdAt: "2026-10-07T08:30:00.000Z",
    links: [],
  },
  {
    id: "asset_mock_reconcile_spec",
    kind: "document",
    mime: "application/pdf",
    byteSize: 412_800,
    sha256: mockSha256("reconcile-spec"),
    origin: {},
    createdAt: "2026-10-06T10:00:00.000Z",
    links: [
      { targetKind: "work_item", targetId: RESEARCH_TASK_ID, role: "reference", createdAt: "2026-10-06T10:00:00.000Z" },
    ],
  },
];

export function createMockAssetFixtures(): MockAssetFixtures {
  return {
    assets: structuredClone(ASSETS),
    images: {
      asset_mock_empty_light: emptyStateArt("#f6f3ec", "#1f2a44", "#7fb4ff"),
      asset_mock_empty_dark: emptyStateArt("#1b2030", "#dfe6f3", "#3b6fe0"),
      asset_mock_empty_icon: iconArt(),
      asset_mock_brand_palette: paletteArt(),
      asset_mock_checkout_wireframe: wireframeArt(),
    },
  };
}

