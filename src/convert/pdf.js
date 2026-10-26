import { pdfEnv } from './env.js';
import { splitSyllables, createMixedSegmenter } from './segment.js';

/** Bộ tách từ Việt–Anh, nạp kèm từ điển ~110 KB lúc mở PDF đầu tiên. */
let mixedSegmenter = null;
const BULLET_RE = /^[•●▪■◦○◆◇►▶➢➤✓✔•‣⁃]\s*/;
const LONE_NUMBER_RE = /^(?:trang\s*)?\d{1,4}(?:\s*\/\s*\d{1,4})?$/i;

/**
 * Ghép text của PDF thành markdown: dựng dòng theo thứ tự content stream,
 * đoán heading theo cỡ chữ, bỏ header/footer lặp lại và số trang.
 */
export async function pdfToMarkdown(buf, { pageMarkers = true, ocr = true, onProgress, onStatus } = {}) {
  const pdfjsLib = await pdfEnv.loadLib();
  const task = pdfjsLib.getDocument({
    data: new Uint8Array(buf),
    ...pdfEnv.documentOptions,
    // từ pdf.js 6.4, tên font (dùng để nhận chữ đậm) chỉ được giữ khi bật cờ này
    fontExtraProperties: true,
  });
  mixedSegmenter ??= createMixedSegmenter(await pdfEnv.loadWords());

  const pages = [];
  const boldFonts = new Map();
  const ocrPages = [];
  let ocrEngine = null;
  try {
    const doc = await task.promise;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      await resolveBoldFonts(page, content.items, boldFonts);
      let lines = buildLines(content.items, boldFonts);

      // trang không có lớp chữ (bản scan, ảnh chụp): vẽ ra ảnh rồi OCR
      if (ocr && charCount(lines) < 20) {
        onStatus?.(ocrEngine ? `Reading scanned page ${n} (OCR)…` : 'Loading OCR engine (~5 MB, first time only)…');
        ocrEngine ??= await import('./ocr.js').then((m) => m.createOcr(doc));
        const ocrLines = await ocrEngine.recognizePage(page, (p) => onProgress?.((n - 1 + p) / doc.numPages));
        if (charCount(ocrLines) > charCount(lines)) {
          lines = ocrLines;
          ocrPages.push(n);
        }
      }
      pages.push(lines);
      page.cleanup();
      onProgress?.(n / doc.numPages);
    }
  } finally {
    await ocrEngine?.terminate();
    await task.destroy();
  }

  const warnings = [];
  if (ocrPages.length) {
    warnings.push(`Ran OCR on ${ocrPages.length} scanned page${ocrPages.length > 1 ? 's' : ''} (${summarizePages(ocrPages)}). Recognized text may contain mistakes — double-check anything important.`);
  } else if (charCount(pages.flat()) < pages.length * 25) {
    warnings.push('This PDF has almost no text layer (probably a scan). Turn on OCR to recognize the text.');
  }

  stripRepeated(pages);
  const headings = headingLevels(pages);

  const parts = pages.map((lines, i) => {
    const body = renderPage(lines, headings);
    return pageMarkers ? `<!-- page ${i + 1} -->\n\n${body}` : body;
  });

  return {
    markdown: parts.join('\n\n'),
    warnings,
    unitCount: pages.length,
    unitLabel: 'pages',
  };
}

function charCount(lines) {
  return lines.reduce((sum, l) => sum + l.text.length, 0);
}

/** [1,2,3,5,7,8] → "1–3, 5, 7–8" */
function summarizePages(nums) {
  const parts = [];
  for (let i = 0; i < nums.length; i++) {
    let j = i;
    while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
    parts.push(i === j ? `${nums[i]}` : `${nums[i]}–${nums[j]}`);
    i = j;
  }
  return `${nums.length > 1 ? 'pages' : 'page'} ${parts.join(', ')}`;
}

/**
 * Font chỉ được nạp khi pdf.js dựng operator list của trang; sau đó tên font
 * (vd. "Arial-BoldMT") cho biết chữ đậm. Cách làm theo opengovsg/pdf2md.
 */
async function resolveBoldFonts(page, items, cache) {
  const ids = new Set(items.map((it) => it.fontName).filter((id) => id && !cache.has(id)));
  if (!ids.size) return;
  try {
    await page.getOperatorList();
  } catch {
    for (const id of ids) cache.set(id, false);
    return;
  }
  for (const id of ids) {
    let bold = false;
    try {
      const font = page.commonObjs.has(id)
        ? page.commonObjs.get(id)
        : await Promise.race([
          new Promise((resolve) => page.commonObjs.get(id, resolve)),
          new Promise((resolve) => setTimeout(resolve, 300)),
        ]);
      const name = (font?.name || '').toLowerCase();
      bold = name ? /bold|black|heavy|semibold|demi/.test(name) : font?.bold === true;
    } catch {
      // font không đọc được thì coi như chữ thường
    }
    cache.set(id, bold);
  }
}

/** Gom các text item thành dòng, giữ thứ tự xuất hiện trong content stream. */
function buildLines(items, boldFonts) {
  const lines = [];
  let cur = null;

  const close = () => {
    if (cur) {
      const text = finishLine(cur);
      const bold = cur.segs.every((s) => s.bold);
      if (text) lines.push({ text, y: cur.y, x: cur.x, size: cur.size, bold });
    }
    cur = null;
  };

  for (const it of items) {
    if (!('str' in it)) continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || 1;

    if (it.str === '' || /^\s+$/.test(it.str)) {
      if (cur && it.str) cur.pendingSpace = true;
      if (it.hasEOL) close();
      continue;
    }

    const sameLine =
      cur &&
      Math.abs(y - cur.y) < Math.max(size, cur.size) * 0.5 &&
      x > cur.endX - Math.max(size, cur.size) * 0.5;

    if (!sameLine) {
      close();
      cur = { y, x, size, endX: x, segs: [], pendingSpace: false };
    }

    cur.segs.push({
      str: it.str,
      gap: cur.segs.length ? x - cur.endX : 0,
      space: cur.pendingSpace,
      size,
      bold: boldFonts.get(it.fontName) === true,
    });
    cur.pendingSpace = false;
    cur.endX = x + it.width;
    cur.size = Math.max(cur.size, size);
    if (it.hasEOL) close();
  }
  close();
  return lines;
}

function finishLine(line) {
  const { segs } = line;
  const glyphs = segs.filter((s) => s.str.trim().length === 1).length;

  // chữ giãn cách kiểu "C H Ư Ơ N G": mỗi ký tự là một item, khoảng trống giữa
  // các từ rộng hơn hẳn khoảng giãn giữa các ký tự
  if (segs.length >= 4 && glyphs / segs.length >= 0.8) {
    const gaps = segs.slice(1).map((s) => s.gap).sort((p, q) => p - q);
    const median = gaps[Math.floor(gaps.length / 2)];
    let text = segs[0].str.trim();
    for (const s of segs.slice(1)) {
      const wordBreak = s.gap > Math.max(median * 1.6, s.size * 0.25);
      text += (wordBreak ? ' ' : '') + s.str.trim();
    }
    return clean(text);
  }

  let text = '';
  for (const s of segs) {
    const needSpace =
      text &&
      !/\s$/.test(text) &&
      !/^\s/.test(s.str) &&
      (s.space || s.gap > s.size * 0.18);
    text += (needSpace ? ' ' : '') + s.str;
  }
  return clean(text);
}

function clean(text) {
  // NFC: nhiều PDF lưu chữ có dấu dạng tổ hợp (O + móc + ngã) — vừa tốn token vừa làm
  // "Ỡ" không còn là một ký tự khi ghép chữ giãn cách
  const nfc = text.normalize('NFC').replace(/\s+/g, ' ').trim();
  return fixSpacedLetters(nfc).replace(/(\d) \. (?=\d)/g, '$1.');
}

/**
 * Slide thiết kế hay giãn chữ thành "C H Ư Ơ N G 4" và PDF không còn giữ ranh giới từ.
 * Gom chuỗi chữ cái đơn lẻ lại rồi tách theo âm tiết tiếng Việt; không được thì tách
 * lẫn Việt–Anh bằng từ điển ("CASESTUDY" → "CASE STUDY"); vẫn không được thì ghép liền.
 */
function fixSpacedLetters(text) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 4) {
      const words = mixedSegmenter ? mixedSegmenter(run) : splitSyllables(run);
      out.push(words ? words.join(' ') : run.join(''));
    } else {
      out.push(...run);
    }
    run = [];
  };
  for (const token of text.split(' ')) {
    if (/^\p{L}$/u.test(token)) run.push(token);
    else {
      flush();
      out.push(token);
    }
  }
  flush();
  return out.join(' ');
}

/**
 * Bỏ header/footer: dòng ở mép trên/dưới trang lặp lại trên nhiều trang (so khớp sau khi
 * thay số bằng #, để "Chương 4 … 12" và "Chương 4 … 13" là một), cùng số trang đứng riêng.
 */
function stripRepeated(pages) {
  const edges = pages.map(edgeLines);
  const seen = new Map();
  edges.forEach((edge) => {
    for (const key of new Set([...edge].map((l) => normalize(l.text)))) {
      seen.set(key, (seen.get(key) || 0) + 1);
    }
  });
  const threshold = Math.max(3, Math.ceil(pages.length * 0.04));
  for (let i = 0; i < pages.length; i++) {
    // footer kiểu "Phần 4.1 · Tên phần 12" ở trang 12
    const pageNumRe = new RegExp(`(?:^|\\s)${i + 1}$|^${i + 1}\\s`);
    pages[i] = pages[i].filter((l) => {
      if (!edges[i].has(l) || l.text.length > 120) return true;
      if (LONE_NUMBER_RE.test(l.text)) return false;
      if (l.text.length <= 100 && pageNumRe.test(l.text)) return false;
      return (seen.get(normalize(l.text)) || 0) < threshold;
    });
  }
}

function edgeLines(lines) {
  const ys = [...new Set(lines.map((l) => l.y))].sort((p, q) => p - q);
  const low = new Set(ys.slice(0, 2));
  const high = new Set(ys.slice(-2));
  return new Set(lines.filter((l) => low.has(l.y) || high.has(l.y)));
}

function normalize(text) {
  return text.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
}

/**
 * Cỡ chữ thân bài = cỡ chiếm nhiều ký tự nhất. Các cỡ lớn hơn rõ rệt mà được dùng cho
 * dòng trông như tiêu đề sẽ thành heading; cỡ gần nhau (chênh < 10%) chung một cấp, tối đa 3 cấp.
 */
function headingLevels(pages) {
  const all = new Map();
  const headingLike = new Map();
  for (const lines of pages) {
    for (const l of lines) {
      // chiều cao dòng OCR dao động theo nét chữ, không dùng để đoán cỡ chữ
      if (l.ocr) continue;
      const key = roundSize(l.size);
      all.set(key, (all.get(key) || 0) + l.text.length);
      if (looksLikeHeading(l.text)) headingLike.set(key, (headingLike.get(key) || 0) + l.text.length);
    }
  }
  const levels = new Map();
  if (!all.size) return { levels, body: 0, boldLevel: 2 };
  const [body, bodyWeight] = [...all.entries()].sort((p, q) => q[1] - p[1])[0];
  const candidates = [...headingLike.keys()]
    .filter((s) => s >= body * 1.15 && headingLike.get(s) < bodyWeight)
    .sort((p, q) => q - p);

  let level = 0;
  let prev = null;
  for (const s of candidates) {
    if (prev === null || prev / s > 1.1) level++;
    if (level > 3) break;
    levels.set(s, level);
    prev = s;
  }
  // chỉ có một cấp thì dùng ## để tài liệu không toàn H1
  if (level === 1) for (const s of levels.keys()) levels.set(s, 2);
  const deepest = Math.max(1, ...levels.values());
  return { levels, body, boldLevel: Math.min(deepest + 1, 4) };
}

function looksLikeHeading(text) {
  return text.length <= 120 && /\p{L}/u.test(text) && !/[.,;:]$/.test(text);
}

const SECTION_RE = /^(?:\d+(?:\.\d+)*\.?|[IVXLC]+\.|[A-Z]\.|(?:chương|phần|mục|bài|chapter|section|part)\s+(?:\d+|[IVXLC]+)\b)\s/i;

/**
 * Tài liệu Word xuất PDF hay để tiêu đề mục cùng cỡ chữ thân bài, chỉ in đậm.
 * Chỉ nhận dòng đậm khi viết hoa toàn bộ hoặc mở đầu bằng số mục, để không biến nhãn đậm thành heading.
 */
function isBoldHeading(l, body) {
  if (!l.bold || !body || Math.abs(l.size - body) > body * 0.15) return false;
  if (l.text.length > 90 || !looksLikeHeading(l.text) || BULLET_RE.test(l.text)) return false;
  const letters = l.text.replace(/[^\p{L}]/gu, '');
  const allCaps = letters.length >= 3 && letters === letters.toLocaleUpperCase('vi');
  return allCaps || SECTION_RE.test(l.text);
}

function roundSize(size) {
  return Math.round(size * 2) / 2;
}

function renderPage(lines, { levels, body, boldLevel }) {
  const blocks = [];
  let para = null;

  const flush = () => {
    if (para) blocks.push(para.text);
    para = null;
  };

  for (const l of lines) {
    const sizeLevel = l.ocr ? 0 : levels.get(roundSize(l.size));
    const level = sizeLevel && looksLikeHeading(l.text) ? sizeLevel : isBoldHeading(l, body) ? boldLevel : 0;
    const isHeading = level > 0;

    if (isHeading) {
      const prev = blocks.at(-1);
      // tiêu đề dài bị xuống dòng: nối vào heading ngay trước nếu cùng cấp
      if (!para && prev && prev.level === level && prev.size === l.size && Math.abs(prev.y - l.y) < l.size * 1.8) {
        prev.text += ' ' + l.text;
        prev.y = l.y;
        continue;
      }
      flush();
      blocks.push({ heading: true, level, text: l.text, y: l.y, size: l.size });
      continue;
    }

    const bullet = BULLET_RE.test(l.text);
    const text = bullet ? '- ' + l.text.replace(BULLET_RE, '') : l.text;
    if (bullet && text === '- ') continue;

    const continues =
      para &&
      !bullet &&
      Math.abs(para.size - l.size) <= para.size * 0.12 &&
      para.y - l.y > 0 &&
      para.y - l.y <= l.size * 1.75;

    if (continues) {
      para.text += ' ' + text;
      para.y = l.y;
    } else {
      flush();
      para = { text, y: l.y, size: l.size };
    }
  }
  flush();

  return blocks
    .map((b) => (typeof b === 'string' ? b : `${'#'.repeat(b.level)} ${b.text}`))
    .join('\n\n');
}
