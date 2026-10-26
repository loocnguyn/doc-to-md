// tesseract.js là CommonJS: chỉ có default export khi đi qua bundler
import Tesseract from 'tesseract.js';
import { ocrEnv } from './env.js';

const { createWorker } = Tesseract;

const SCALE = 2;

/**
 * OCR cho trang PDF không có lớp chữ: pdf.js vẽ trang ra canvas, tesseract.js (WASM) nhận dạng.
 * Trả về các dòng cùng dạng với dòng lấy từ lớp chữ ({ text, x, y, size }) để phần dựng
 * markdown phía sau (heading theo cỡ chữ, gộp đoạn) dùng chung được.
 */
export async function createOcr(doc) {
  let progress = () => {};
  const worker = await createWorker(['vie', 'eng'], 1, {
    ...ocrEnv.workerOptions,
    logger: (m) => {
      if (m.status === 'recognizing text') progress(m.progress);
    },
  });

  return {
    async recognizePage(page, onProgress) {
      progress = onProgress || (() => {});
      const viewport = page.getViewport({ scale: SCALE });
      // canvasFactory của pdf.js: canvas DOM trong trình duyệt, @napi-rs/canvas trong Node
      const { canvas, context } = doc.canvasFactory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
      // intent 'print' để pdf.js không chờ requestAnimationFrame: tab bị ẩn
      // (người dùng chuyển tab trong lúc OCR) thì rAF dừng và render treo vô hạn
      await page.render({ canvasContext: context, canvas, viewport, intent: 'print' }).promise;

      const { data } = await worker.recognize(ocrEnv.toImage(canvas), {}, { blocks: true });
      doc.canvasFactory.destroy({ canvas, context });
      return toLines(data.blocks || [], viewport.height);
    },
    terminate: () => worker.terminate(),
  };
}

function toLines(blocks, pageHeight) {
  const lines = [];
  for (const block of blocks) {
    for (const para of block.paragraphs || []) {
      for (const line of para.lines || []) {
        // đường kẻ dọc của bảng bị đọc thành "|" đứng lẻ
        const text = line.text
          .replace(/(^|\s)[|¦](?=\s|$)/g, ' ')
          .replace(/^[\s|¦]+|[\s|¦]+$/g, '')
          .replace(/\s+/g, ' ');
        // dòng nhận dạng kém hoặc toàn ký hiệu thường là nhiễu từ hình vẽ, logo
        const alnum = (text.match(/[\p{L}\p{N}]/gu) || []).length;
        if (line.confidence < 60 || alnum < 2 || alnum / text.replace(/\s/g, '').length < 0.6) continue;
        const { x0, y0, y1 } = line.bbox;
        lines.push({
          text,
          x: x0 / SCALE,
          // toạ độ PDF tính từ dưới lên, ảnh tính từ trên xuống
          y: (pageHeight - y1) / SCALE,
          size: (y1 - y0) / SCALE,
          bold: false,
          ocr: true,
        });
      }
    }
  }
  return lines;
}
