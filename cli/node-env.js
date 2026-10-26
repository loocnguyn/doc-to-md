import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DOMParser, HTMLElement } from 'linkedom';
// bản legacy: bản chuẩn của pdf.js 6 cần API mới hơn Node 22 (Promise.try)
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { pdfEnv, officeEnv, ocrEnv } from '../src/convert/env.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const pdfjsDir = dirname(require.resolve('pdfjs-dist/package.json'));

// bộ chuyển đổi DOCX/PPTX dùng DOMParser của trình duyệt
globalThis.DOMParser ??= DOMParser;

// turndown-plugin-gfm đọc table.rows và tr.cells; linkedom dựng <table>, <tr> từ HTML
// thành HTMLElement chung nên phải gắn lên đó và chỉ trả giá trị cho đúng thẻ
const childrenNamed = (el, names) => [...el.children].filter((c) => names.includes(c.nodeName));
if (!('rows' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'rows', {
    get() {
      if (this.nodeName !== 'TABLE') return undefined;
      return childrenNamed(this, ['THEAD', 'TBODY', 'TFOOT', 'TR'])
        .flatMap((c) => (c.nodeName === 'TR' ? [c] : childrenNamed(c, ['TR'])));
    },
  });
}
if (!('cells' in HTMLElement.prototype)) {
  Object.defineProperty(HTMLElement.prototype, 'cells', {
    get() {
      return this.nodeName === 'TR' ? childrenNamed(this, ['TD', 'TH']) : undefined;
    },
  });
}

pdfjsLib.GlobalWorkerOptions.workerSrc = pathToFileURL(join(pdfjsDir, 'legacy/build/pdf.worker.mjs')).href;
pdfEnv.loadLib = async () => pdfjsLib;
pdfEnv.documentOptions = {
  cMapUrl: join(pdfjsDir, 'cmaps') + '/',
  cMapPacked: true,
  standardFontDataUrl: join(pdfjsDir, 'standard_fonts') + '/',
  verbosity: 0,
};
pdfEnv.loadWords = () => readFile(join(here, '../src/convert/data/words-en.txt'), 'utf8');

// bản "node" của office-oxide-wasm 0.1.8 là CommonJS trong package "type": "module" nên không
// import được; dùng bản web và tự đọc file .wasm từ đĩa
let office;
officeEnv.loadWasmDocument = () => {
  office ??= (async () => {
    const mod = await import('office-oxide-wasm/web');
    const wasmPath = join(dirname(require.resolve('office-oxide-wasm/package.json')), 'web/office_oxide_bg.wasm');
    await mod.default({ module_or_path: await readFile(wasmPath) });
    return mod.WasmDocument;
  })();
  return office;
};

ocrEnv.toImage = (canvas) => canvas.toBuffer('image/png');
// tesseract.js trong Node mặc định lưu dữ liệu ngôn ngữ ra thư mục hiện tại
ocrEnv.workerOptions = { cachePath: join(tmpdir(), 'doc-to-md-tessdata') };
