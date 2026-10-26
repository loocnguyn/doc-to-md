/**
 * Những thứ phụ thuộc môi trường chạy. Bộ chuyển đổi dùng chung cho web và CLI;
 * mỗi bên điền phần của mình: src/browser-env.js (Vite) và cli/node-env.js (Node).
 */
export const pdfEnv = {
  /** Nạp module pdf.js: bản chuẩn cho trình duyệt (tải khi cần), bản legacy cho Node. */
  loadLib: async () => {
    throw new Error('pdf.js is not configured');
  },
  /** Thêm vào getDocument(): cMapUrl, standardFontDataUrl… */
  documentOptions: {},
  /** Trả về danh sách từ tiếng Anh (mỗi dòng một từ) cho bộ tách chữ giãn cách. */
  loadWords: async () => '',
};

export const officeEnv = {
  /** Trả về class WasmDocument của office-oxide-wasm đã khởi tạo xong. */
  loadWasmDocument: async () => {
    throw new Error('office-oxide-wasm is not configured');
  },
};

/** Ảnh trang đã vẽ → đầu vào tesseract (trình duyệt nhận canvas, Node cần PNG buffer). */
export const ocrEnv = {
  toImage: (canvas) => canvas,
  /** Thêm vào createWorker() của tesseract.js (vd. cachePath trong Node). */
  workerOptions: {},
};
