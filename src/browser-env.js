import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { pdfEnv, officeEnv } from './convert/env.js';

// pdf.js (~430 KB) chỉ tải khi người dùng thả PDF vào, để trang mở nhanh
let pdfjs;
pdfEnv.loadLib = () => {
  pdfjs ??= import('pdfjs-dist').then((lib) => {
    lib.GlobalWorkerOptions.workerSrc = workerUrl;
    const cdn = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${lib.version}`;
    pdfEnv.documentOptions = {
      cMapUrl: `${cdn}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${cdn}/standard_fonts/`,
    };
    return lib;
  });
  return pdfjs;
};
pdfEnv.loadWords = () => import('./convert/data/words-en.txt?raw').then((m) => m.default);

let office;
officeEnv.loadWasmDocument = () => {
  office ??= Promise.all([
    import('office-oxide-wasm/web'),
    // file .wasm không nằm trong bảng exports của package nên trỏ thẳng đường dẫn cho Vite
    import('../node_modules/office-oxide-wasm/web/office_oxide_bg.wasm?url'),
  ]).then(async ([mod, wasm]) => {
    await mod.default({ module_or_path: wasm.default });
    return mod.WasmDocument;
  });
  return office;
};
