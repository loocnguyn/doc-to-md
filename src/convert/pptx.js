import JSZip from 'jszip';

const REL_NOTES = /\/notesSlide$/;
const TITLE_TYPES = new Set(['title', 'ctrTitle']);
const SKIP_TYPES = new Set(['sldNum', 'dt', 'ftr', 'sldImg', 'hdr']);
const BODY_TYPES = new Set(['body', 'obj', undefined]);

export async function pptxToMarkdown(buf, { pageMarkers = true, notes = true, onProgress } = {}) {
  const zip = await JSZip.loadAsync(buf);
  const slidePaths = await slideOrder(zip);
  if (!slidePaths.length) throw new Error('No slides found in this file');

  const out = [];
  let hidden = 0;
  let noteCount = 0;

  for (let i = 0; i < slidePaths.length; i++) {
    const path = slidePaths[i];
    const xml = await readXml(zip, path);
    if (!xml) continue;
    const isHidden = xml.documentElement.getAttribute('show') === '0';
    if (isHidden) hidden++;

    const rels = await readRels(zip, path);
    const { title, blocks } = await readShapes(xml, zip, rels);
    const heading = `## Slide ${i + 1}${title ? `: ${title}` : ''}${isHidden ? ' (hidden)' : ''}`;
    const parts = [];
    if (pageMarkers) parts.push(`<!-- slide ${i + 1} -->`);
    parts.push(heading, ...blocks);

    if (notes) {
      const text = await readNotes(zip, path);
      if (text) {
        noteCount++;
        parts.push(text.split('\n').map((line, j) => (j === 0 ? `> **Notes:** ${line}` : `> ${line}`)).join('\n'));
      }
    }
    out.push(parts.join('\n\n'));
    onProgress?.((i + 1) / slidePaths.length);
  }

  const warnings = [];
  if (hidden) warnings.push(`${hidden} hidden slide${hidden > 1 ? 's were' : ' was'} kept and marked "(hidden)".`);
  if (notes && noteCount) warnings.push(`Included speaker notes from ${noteCount} slide${noteCount > 1 ? 's' : ''}.`);

  return { markdown: out.join('\n\n'), warnings, unitCount: slidePaths.length, unitLabel: 'slides' };
}

/** Thứ tự slide thật nằm trong presentation.xml, không phải theo tên file. */
async function slideOrder(zip) {
  const pres = await readXml(zip, 'ppt/presentation.xml');
  const rels = await readRels(zip, 'ppt/presentation.xml');
  const ordered = [];
  if (pres) {
    for (const id of byTag(pres, 'p:sldId')) {
      const rid = id.getAttribute('r:id');
      const target = rels.get(rid)?.target;
      if (target) ordered.push(target);
    }
  }
  if (ordered.length) return ordered;

  return Object.keys(zip.files)
    .filter((p) => /^ppt\/slides\/slide\d+\.xml$/.test(p))
    .sort((p, q) => slideNum(p) - slideNum(q));
}

function slideNum(path) {
  return Number(path.match(/(\d+)\.xml$/)[1]);
}

async function readShapes(xml, zip, rels) {
  const tree = byTag(xml, 'p:spTree')[0];
  let title = '';
  const blocks = [];
  // slide tự thiết kế không dùng placeholder tiêu đề: nhớ đoạn chữ ngắn có cỡ lớn nhất
  let bigText = null;
  if (tree) await walk(tree);
  if (!title && bigText && bigText.size >= 1800) {
    title = bigText.text;
    blocks.splice(blocks.indexOf(bigText.block), 1);
  }
  return { title, blocks };

  // đọc theo vị trí trên → dưới, trái → phải thay vì thứ tự lớp (cách của MarkItDown);
  // shape không có toạ độ (placeholder kế thừa từ layout, thường là tiêu đề) đứng đầu
  async function walk(parent) {
    const nodes = [...parent.children]
      .filter((n) => ['p:sp', 'p:grpSp', 'p:graphicFrame', 'p:pic'].includes(n.nodeName))
      .map((n) => ({ n, pos: position(n) }))
      .sort((p, q) => p.pos.y - q.pos.y || p.pos.x - q.pos.x);
    for (const { n } of nodes) {
      switch (n.nodeName) {
        case 'p:sp':
          shape(n);
          break;
        case 'p:grpSp':
          await walk(n);
          break;
        case 'p:pic':
          picture(n);
          break;
        case 'p:graphicFrame':
          await graphicFrame(n);
          break;
      }
    }
  }

  async function graphicFrame(node) {
    const tbl = byTag(node, 'a:tbl')[0];
    if (tbl) {
      blocks.push(table(tbl));
      return;
    }
    const chartRef = byTag(node, 'c:chart')[0];
    if (chartRef) {
      const target = rels.get(chartRef.getAttribute('r:id'))?.target;
      const md = target && (await chart(zip, target));
      if (md) blocks.push(md);
      return;
    }
    const diagram = byTag(node, 'dgm:relIds')[0];
    if (diagram) {
      const target = rels.get(diagram.getAttribute('r:dm'))?.target;
      const md = target && (await smartArt(zip, target));
      if (md) blocks.push(md);
    }
  }

  function picture(pic) {
    const descr = (byTag(pic, 'p:cNvPr')[0]?.getAttribute('descr') || '').replace(/\s+/g, ' ').trim();
    if (descr) blocks.push(`[Image: ${descr}]`);
  }

  function shape(sp) {
    const ph = byTag(sp, 'p:ph')[0];
    const type = ph ? ph.getAttribute('type') || undefined : null;
    if (type && SKIP_TYPES.has(type)) return;
    const body = byTag(sp, 'p:txBody')[0];
    if (!body) return;
    const paras = byTag(body, 'a:p').map(paragraph).filter((p) => p.text);
    if (!paras.length) return;

    if (ph && TITLE_TYPES.has(type) && !title) {
      title = paras.map((p) => p.text).join(' ');
      return;
    }

    const asList = ph !== null && BODY_TYPES.has(type);
    const lines = paras.map((p) => {
      const bullet = p.bullet === true || (asList && p.bullet !== false);
      const indent = '  '.repeat(p.level);
      return bullet ? `${indent}- ${p.text}` : p.text;
    });
    const block = lines.join('\n');
    blocks.push(block);

    const text = paras.map((p) => p.text).join(' ');
    const size = Math.max(0, ...byTag(body, 'a:rPr').map((r) => Number(r.getAttribute('sz')) || 0));
    const letters = text.replace(/[^\p{L}]/gu, '').length;
    if (!asList && text.length <= 90 && letters >= 3 && size > (bigText?.size ?? 0)) {
      bigText = { text, size, block };
    }
  }
}

function position(node) {
  const off = byTag(node, 'a:off')[0];
  if (!off) return { x: -Infinity, y: -Infinity };
  return { x: Number(off.getAttribute('x')) || 0, y: Number(off.getAttribute('y')) || 0 };
}

/** Biểu đồ: lấy tên và số liệu từng series thành bảng markdown. */
async function chart(zip, path) {
  const xml = await readXml(zip, path);
  if (!xml) return '';
  const chartEl = byTag(xml, 'c:chart')[0];
  const titleEl = chartEl && [...chartEl.children].find((c) => c.nodeName === 'c:title');
  const title = titleEl ? byTag(titleEl, 'a:t').map((t) => t.textContent).join('').trim() : '';

  const series = byTag(xml, 'c:ser').map((ser) => {
    const tx = [...ser.children].find((c) => c.nodeName === 'c:tx');
    const name = tx ? (byTag(tx, 'c:v')[0]?.textContent || byTag(tx, 'a:t').map((t) => t.textContent).join('')) : '';
    const cat = [...ser.children].find((c) => c.nodeName === 'c:cat' || c.nodeName === 'c:xVal');
    const val = [...ser.children].find((c) => c.nodeName === 'c:val' || c.nodeName === 'c:yVal');
    return { name: name.trim(), cats: points(cat), vals: points(val) };
  });

  const head = `**Chart${title ? `: ${title}` : ''}**`;
  if (!series.length) return head;
  const cats = series[0].cats;
  const count = Math.max(cats.size, ...series.map((s) => s.vals.size));
  const rows = [];
  for (let i = 0; i < count; i++) {
    rows.push([cats.get(i) ?? String(i + 1), ...series.map((s) => s.vals.get(i) ?? '')]);
  }
  const header = ['Category', ...series.map((s, i) => s.name || `Series ${i + 1}`)];
  return [head, '', mdTable([header, ...rows])].join('\n');
}

function points(node) {
  const map = new Map();
  if (!node) return map;
  for (const pt of byTag(node, 'c:pt')) {
    map.set(Number(pt.getAttribute('idx')), byTag(pt, 'c:v')[0]?.textContent ?? '');
  }
  return map;
}

/** SmartArt: chữ nằm trong part data riêng; lấy các node có chữ thành danh sách. */
async function smartArt(zip, path) {
  const xml = await readXml(zip, path);
  if (!xml) return '';
  const items = byTag(xml, 'dgm:pt')
    .filter((pt) => !pt.getAttribute('type') || pt.getAttribute('type') === 'node')
    .map((pt) => byTag(pt, 'a:t').map((t) => t.textContent).join('').replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  return items.map((t) => `- ${t}`).join('\n');
}

function paragraph(p) {
  const pPr = p.getElementsByTagName('a:pPr')[0];
  const level = Number(pPr?.getAttribute('lvl') || 0);
  let bullet;
  if (pPr) {
    if (pPr.getElementsByTagName('a:buNone').length) bullet = false;
    else if (pPr.getElementsByTagName('a:buChar').length || pPr.getElementsByTagName('a:buAutoNum').length) bullet = true;
  }
  let text = '';
  for (const child of p.children) {
    if (child.nodeName === 'a:r' || child.nodeName === 'a:fld') {
      text += byTag(child, 'a:t').map((t) => t.textContent).join('');
    } else if (child.nodeName === 'a:br') {
      text += ' ';
    }
  }
  return { text: text.replace(/\s+/g, ' ').trim(), level, bullet };
}

function table(tbl) {
  const rows = byTag(tbl, 'a:tr').map((tr) =>
    byTag(tr, 'a:tc')
      .filter((tc) => !tc.getAttribute('hMerge'))
      .map((tc) => byTag(tc, 'a:p').map((p) => paragraph(p).text).filter(Boolean).join(' ').replace(/\|/g, '/')),
  );
  return mdTable(rows);
}

function mdTable(rows) {
  if (!rows.length) return '';
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r) => [...r, ...Array(width - r.length).fill('')];
  const line = (r) => `| ${pad(r).map((c) => String(c).replace(/\|/g, '/')).join(' | ')} |`;
  return [line(rows[0]), `| ${Array(width).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)].join('\n');
}

async function readNotes(zip, slidePath) {
  const rels = await readRels(zip, slidePath);
  const target = [...rels.values()].find((r) => REL_NOTES.test(r.type))?.target;
  if (!target) return '';
  const xml = await readXml(zip, target);
  if (!xml) return '';
  const texts = [];
  for (const sp of byTag(xml, 'p:sp')) {
    const ph = byTag(sp, 'p:ph')[0];
    if (!ph || ph.getAttribute('type') !== 'body') continue;
    for (const p of byTag(sp, 'a:p')) {
      const { text } = paragraph(p);
      if (text) texts.push(text);
    }
  }
  return texts.join('\n');
}

/** Đọc file .rels của một part, trả về Map rId → { type, target (đường dẫn trong zip) }. */
async function readRels(zip, partPath) {
  const dir = partPath.slice(0, partPath.lastIndexOf('/'));
  const name = partPath.slice(partPath.lastIndexOf('/') + 1);
  const xml = await readXml(zip, `${dir}/_rels/${name}.rels`);
  const map = new Map();
  if (!xml) return map;
  for (const rel of byTag(xml, 'Relationship')) {
    if (rel.getAttribute('TargetMode') === 'External') continue;
    map.set(rel.getAttribute('Id'), {
      type: rel.getAttribute('Type') || '',
      target: resolvePath(dir, rel.getAttribute('Target') || ''),
    });
  }
  return map;
}

function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = dir.split('/');
  for (const seg of target.split('/')) {
    if (seg === '..') parts.pop();
    else if (seg !== '.') parts.push(seg);
  }
  return parts.join('/');
}

async function readXml(zip, path) {
  const file = zip.file(path);
  if (!file) return null;
  const text = await file.async('string');
  return new DOMParser().parseFromString(text, 'application/xml');
}

function byTag(node, tag) {
  return Array.from(node.getElementsByTagName(tag));
}
