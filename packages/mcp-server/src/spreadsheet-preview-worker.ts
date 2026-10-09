/**
 * @input  依赖：已限制大小的文件字节、预览预算、SheetJS 与 yauzl
 * @output 发送：有界的工作表文本矩阵，或不包含文件内容/路径的错误码
 * @pos    隔离 Excel/CSV 解析；不计算公式、不加载外链、不执行宏、不解压到磁盘
 */
import { parentPort, workerData } from "node:worker_threads";
import * as XLSX from "xlsx";
import yauzl from "yauzl";
import type { ProjectFilePreviewConfig } from "./project-file-preview-config.js";

const { bytes, extension, config } = workerData as {
  bytes: Uint8Array; extension: string; config: ProjectFilePreviewConfig;
};

// 既校验 ZIP 声明大小，也实际流式解压计数，不能只相信中央目录的尺寸。
async function validateArchive(buffer: Buffer): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true }, (error, zip) => {
      if (error || !zip) return reject(new Error("invalid_spreadsheet"));
      let declared = 0;
      let expanded = 0;
      const fail = () => { zip.close(); reject(new Error("invalid_spreadsheet")); };
      zip.on("error", fail);
      zip.on("end", resolve);
      zip.on("entry", (entry: yauzl.Entry) => {
        declared += entry.uncompressedSize;
        if (declared > config.maxExpandedBytes || zip.entryCount > config.maxArchiveEntries || (entry.generalPurposeBitFlag & 1)) return fail();
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return fail();
          stream.on("error", fail);
          stream.on("data", (chunk: Buffer) => {
            expanded += chunk.length;
            if (expanded > config.maxExpandedBytes) { stream.destroy(); fail(); }
          });
          stream.on("end", () => zip.readEntry());
        });
      });
      zip.readEntry();
    });
  });
}

async function main() {
  const buffer = Buffer.from(bytes);
  if (extension === ".xlsx") await validateArchive(buffer);
  const input = extension === ".xlsx" ? buffer : new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const workbook = XLSX.read(input, {
    type: extension === ".xlsx" ? "buffer" : "string",
    raw: extension !== ".xlsx", FS: extension === ".tsv" ? "\t" : ",",
    sheetRows: config.maxRows, cellHTML: false, cellFormula: true,
    cellStyles: false, bookVBA: false, cellNF: false,
  });
  let remainingChars = config.maxTextChars;
  const visible = workbook.SheetNames.filter((_name, index) => !workbook.Workbook?.Sheets?.[index]?.Hidden);
  const sheets = visible.slice(0, config.maxSheets).map((name) => {
    const sheet = workbook.Sheets[name]!;
    const range = XLSX.utils.decode_range(sheet["!fullref"] ?? sheet["!ref"] ?? "A1");
    const rowCount = sheet["!ref"] ? range.e.r + 1 : 0;
    const columnCount = sheet["!ref"] ? range.e.c + 1 : 0;
    let clipped = false;
    const rows: string[][] = [];
    for (let r = 0; r < Math.min(rowCount, config.maxRows) && remainingChars > 0; r++) {
      const cells: string[] = [];
      for (let c = 0; c < Math.min(columnCount, config.maxColumns); c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
        // 仅显示缓存值；没有缓存时展示公式原文，绝不计算或请求外部数据。
        const raw = cell ? cell.v === undefined && cell.f ? `=${cell.f}` : cell.w ?? String(cell.v ?? "") : "";
        const value = raw.slice(0, Math.min(config.maxCellChars, remainingChars));
        if (value.length < raw.length) clipped = true;
        remainingChars -= value.length;
        cells.push(value);
      }
      rows.push(cells);
    }
    return { name, rows, rowCount, columnCount, truncated: clipped || rows.length < rowCount || columnCount > config.maxColumns };
  });
  parentPort?.postMessage({ sheets, truncated: visible.length > sheets.length });
}

void main().catch(() => parentPort?.postMessage({ error: "invalid_spreadsheet" }));
