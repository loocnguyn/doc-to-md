const CONVERTERS = {
  pdf: () => import('./pdf.js').then((m) => m.pdfToMarkdown),
  docx: () => import('./docx.js').then((m) => m.docxToMarkdown),
  pptx: () => import('./pptx.js').then((m) => m.pptxToMarkdown),
};

export function isSupported(name) {
  return extOf(name) in CONVERTERS;
}

/**
 * @param {File} file
 * @param {{ pageMarkers?: boolean, notes?: boolean, onProgress?: (p: number) => void }} opts
 * @returns {Promise<{ markdown: string, warnings: string[], unitCount: number, unitLabel: string }>}
 */
export async function convertFile(file, opts = {}) {
  const load = CONVERTERS[extOf(file.name)];
  if (!load) throw new Error('Định dạng chưa hỗ trợ');
  const [convert, buf] = await Promise.all([load(), file.arrayBuffer()]);
  const out = await convert(buf, opts);
  return { ...out, markdown: tidy(out.markdown) };
}

function extOf(name) {
  return name.split('.').pop().toLowerCase();
}

function tidy(md) {
  return md
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim() + '\n';
}
