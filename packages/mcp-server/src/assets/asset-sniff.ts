/**
 * @input  依赖：文件完整字节
 * @output 导出：sniffAssetMime（按文件头识别 PNG/JPEG/WebP/GIF/SVG/glb/PDF）、readImageDimensions（PNG/JPEG/WebP/GIF 宽高）、assetKindForMime
 * @pos    纯函数，不碰文件系统、不信扩展名；纯 JS 解析，sidecar 为 Node SEA 单文件，不能引入原生图像依赖
 *
 * ⚠️ 一旦本文件被更新，务必更新以上注释
 */

import type { AssetKind } from "../types.js";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// SVG 文本探测只看文件头这一窗口：根元素之前允许 XML 声明、注释与 DOCTYPE。
const SVG_PROBE_BYTES = 4096;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + signature.length) return false;
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  if (bytes.length < offset + length) return "";
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** SVG 必须整体是合法 UTF-8 且不含 NUL，根元素是 <svg>；否则一律不当作 SVG。 */
function isSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return false;
  }
  if (text.includes("\0")) return false;
  let head = text.slice(0, SVG_PROBE_BYTES).replace(/^﻿/u, "");
  // 逐个剥掉根元素前允许出现的序言片段，剩下的第一个标签必须是 <svg。
  for (;;) {
    const trimmed = head.trimStart();
    const prolog = /^(?:<\?xml[\s\S]*?\?>|<!--[\s\S]*?-->|<!DOCTYPE[^>[]*(?:\[[\s\S]*?\])?\s*>)/iu.exec(trimmed);
    if (!prolog) {
      head = trimmed;
      break;
    }
    head = trimmed.slice(prolog[0].length);
  }
  return /^<svg[\s>/]/iu.test(head);
}

export function sniffAssetMime(bytes: Uint8Array): string | undefined {
  if (startsWith(bytes, PNG_SIGNATURE)) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "glTF") return "model/gltf-binary";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (isSvg(bytes)) return "image/svg+xml";
  return undefined;
}

export function assetKindForMime(mime: string): AssetKind {
  if (mime === "model/gltf-binary") return "model3d";
  if (mime === "application/pdf") return "document";
  return "image";
}

function u16be(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function u16le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function u24le(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16);
}

function u32be(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset]! << 24) >>> 0) + ((bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!);
}

function pngDimensions(bytes: Uint8Array): [number, number] | undefined {
  // 签名(8) + IHDR 长度(4) + "IHDR"(4) 之后紧跟宽、高各 4 字节大端。
  if (bytes.length < 24 || ascii(bytes, 12, 4) !== "IHDR") return undefined;
  return [u32be(bytes, 16), u32be(bytes, 20)];
}

// SOF0..SOF15 中排除 DHT(C4)、JPG(C8)、DAC(CC)，这些标记段里才有帧尺寸。
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);

function jpegDimensions(bytes: Uint8Array): [number, number] | undefined {
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1]!;
    // 填充字节与无长度的独立标记直接跳过。
    if (marker === 0xff) { offset += 1; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = u16be(bytes, offset + 2);
    if (length < 2) return undefined;
    if (JPEG_SOF.has(marker)) {
      if (offset + 9 > bytes.length) return undefined;
      return [u16be(bytes, offset + 7), u16be(bytes, offset + 5)];
    }
    offset += 2 + length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): [number, number] | undefined {
  const chunk = ascii(bytes, 12, 4);
  if (chunk === "VP8 " && bytes.length >= 30) {
    return [u16le(bytes, 26) & 0x3fff, u16le(bytes, 28) & 0x3fff];
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    const b0 = bytes[21]!, b1 = bytes[22]!, b2 = bytes[23]!, b3 = bytes[24]!;
    return [1 + (((b1 & 0x3f) << 8) | b0), 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))];
  }
  if (chunk === "VP8X" && bytes.length >= 30) {
    return [1 + u24le(bytes, 24), 1 + u24le(bytes, 27)];
  }
  return undefined;
}

function gifDimensions(bytes: Uint8Array): [number, number] | undefined {
  return bytes.length >= 10 ? [u16le(bytes, 6), u16le(bytes, 8)] : undefined;
}

/** 解析失败或尺寸为 0 时返回 undefined，宽高留空而不是拒绝入库。 */
export function readImageDimensions(mime: string, bytes: Uint8Array): { width: number; height: number } | undefined {
  const parsed = mime === "image/png" ? pngDimensions(bytes)
    : mime === "image/jpeg" ? jpegDimensions(bytes)
      : mime === "image/webp" ? webpDimensions(bytes)
        : mime === "image/gif" ? gifDimensions(bytes)
          : undefined;
  if (!parsed || parsed[0] <= 0 || parsed[1] <= 0) return undefined;
  return { width: parsed[0], height: parsed[1] };
}
