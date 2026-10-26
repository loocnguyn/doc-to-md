import mammoth from 'mammoth';
import TurndownService from 'turndown';
import { gfm } from 'turndown-plugin-gfm';

export async function docxToMarkdown(buf, { onProgress } = {}) {
  onProgress?.(0.2);
  let images = 0;
  const { value: html } = await mammoth.convertToHtml(
    // bản Node của mammoth đọc Buffer, bản trình duyệt đọc ArrayBuffer
    typeof Buffer !== 'undefined' ? { buffer: Buffer.from(buf) } : { arrayBuffer: buf },
    {
      // bỏ ảnh: base64 nhúng vào md vừa nặng vừa tốn token mà LLM không đọc được
      convertImage: mammoth.images.imgElement(async () => {
        images++;
        return { src: '' };
      }),
    },
  );
  onProgress?.(0.7);

  // bọc đủ <html>: linkedom (Node) không tự dựng khung tài liệu như trình duyệt
  const dom = new DOMParser().parseFromString(`<!doctype html><html><head></head><body>${html}</body></html>`, 'text/html');
  prepareTables(dom);

  const td = new TurndownService({
    headingStyle: 'atx',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  });
  td.use(gfm);
  td.addRule('dropImages', { filter: 'img', replacement: () => '' });
  // mammoth tạo anchor rỗng cho bookmark/mục lục, không cần trong md
  td.addRule('emptyAnchors', {
    filter: (node) => node.nodeName === 'A' && !node.textContent.trim(),
    replacement: () => '',
  });

  const markdown = td.turndown(dom.body);
  onProgress?.(1);

  const warnings = [];
  if (images) warnings.push(`Skipped ${images} image${images > 1 ? 's' : ''} (Markdown keeps text only).`);
  if (!markdown.trim()) warnings.push('No text found in this file.');
  else if (images >= 3 && markdown.length < images * 100) {
    warnings.push('This document is mostly images (screenshots or scans); text inside images is not included.');
  }

  return {
    markdown,
    warnings,
    unitCount: dom.body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li').length,
    unitLabel: 'paragraphs',
  };
}

/**
 * Bảng của Word không có hàng tiêu đề nên plugin gfm sẽ giữ nguyên HTML.
 * Đổi hàng đầu thành <th> và làm phẳng nội dung ô để ra bảng markdown gọn.
 */
function prepareTables(dom) {
  for (const table of dom.querySelectorAll('table')) {
    for (const cellNode of table.querySelectorAll('td, th')) {
      const parts = [...cellNode.querySelectorAll('p, li')].map((p) => p.textContent.trim()).filter(Boolean);
      const text = (parts.length ? parts.join(' ') : cellNode.textContent).replace(/\s+/g, ' ').trim();
      cellNode.textContent = text.replace(/\|/g, '/');
    }
    // không dùng table.rows / tr.cells: DOM giả lập trong Node (linkedom) không có
    const first = table.querySelector('tr');
    if (!first) continue;
    for (const cellNode of [...first.children].filter((c) => c.nodeName === 'TD' || c.nodeName === 'TH')) {
      if (cellNode.nodeName === 'TH') continue;
      const th = dom.createElement('th');
      th.textContent = cellNode.textContent;
      cellNode.replaceWith(th);
    }
  }
}
