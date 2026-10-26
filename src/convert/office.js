import { officeEnv } from './env.js';

/**
 * Định dạng Office cũ (.doc, .ppt, .xls) và Excel (.xlsx) qua office_oxide (Rust → WASM).
 * Chỉ được tải khi người dùng thả đúng loại file này vào.
 */
export async function officeToMarkdown(buf, { format, onProgress } = {}) {
  const WasmDocument = await officeEnv.loadWasmDocument();
  onProgress?.(0.3);

  const doc = new WasmDocument(new Uint8Array(buf), format);
  let markdown;
  try {
    markdown = compactTables(doc.toMarkdown());
  } finally {
    doc.free();
  }
  onProgress?.(1);

  const warnings = [];
  if (!markdown.trim()) warnings.push('No text found in this file.');
  const label = format === 'ppt' ? 'slides' : format === 'xls' || format === 'xlsx' ? 'sheets' : 'paragraphs';
  const count = format === 'ppt'
    ? (markdown.match(/^#{1,2} .*slide/gim) || []).length || null
    : format === 'xls' || format === 'xlsx'
      ? (markdown.match(/^#{1,3} /gm) || []).length || null
      : markdown.split(/\n{2,}/).filter((s) => s.trim()).length;

  return { markdown, warnings, unitCount: count ?? '?', unitLabel: label };
}

/**
 * Sheet Excel thường có vùng định dạng rộng hơn dữ liệu, ra hàng chục cột "|  |".
 * Bỏ cột/hàng rỗng và lấy hàng có chữ đầu tiên làm tiêu đề để đỡ tốn token.
 */
function compactTables(md) {
  const lines = md.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; ) {
    if (!lines[i].startsWith('|')) {
      out.push(lines[i++]);
      continue;
    }
    const block = [];
    while (i < lines.length && lines[i].startsWith('|')) block.push(lines[i++]);
    out.push(...rebuildTable(block));
  }
  return out.join('\n');
}

function rebuildTable(block) {
  const rows = block
    .map(splitRow)
    .filter((cells) => !cells.every((c) => /^:?-{3,}:?$/.test(c)));
  const width = Math.max(0, ...rows.map((r) => r.length));
  const keep = [];
  for (let c = 0; c < width; c++) if (rows.some((r) => r[c])) keep.push(c);
  const kept = rows.map((r) => keep.map((c) => r[c] || '')).filter((r) => r.some(Boolean));
  if (!kept.length) return [];
  const line = (r) => `| ${r.join(' | ')} |`;
  return [line(kept[0]), `| ${keep.map(() => '---').join(' | ')} |`, ...kept.slice(1).map(line)];
}

function splitRow(line) {
  const cells = [];
  let cur = '';
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  for (let i = 0; i < body.length; i++) {
    if (body[i] === '\\' && body[i + 1] === '|') {
      cur += '\\|';
      i++;
    } else if (body[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += body[i];
    }
  }
  cells.push(cur.trim());
  return cells;
}
