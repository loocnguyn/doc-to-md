/**
 * Nhận diện bảng có kẻ viền trong PDF từ các lệnh vẽ của pdf.js (cách "lattice" của
 * pdfplumber / camelot, và bước dựng lưới từ giao điểm đường kẻ của firecrawl/pdf-inspector):
 * gom đoạn thẳng ngang/dọc → nhóm các đoạn cắt nhau → dựng lưới ô → biết ô nào bị gộp.
 * Bảng không có đường kẻ (chỉ căn cột bằng khoảng trắng) chưa được nhận.
 */

// pdf.js mã hoá đường vẽ thành mảng số: [lệnh, toạ độ…] (DrawOPS trong pdf.mjs)
const MOVE_TO = 0;
const LINE_TO = 1;
const CURVE_TO = 2;
const QUAD_TO = 3;
const CLOSE = 4;

const TOL = 2; // sai số (đơn vị PDF ~ 1/72 inch) khi so toạ độ đường kẻ
const THIN = 2.5; // hình chữ nhật mảnh hơn mức này coi là một đường kẻ

/**
 * @param {{ fnArray: number[], argsArray: any[] }} opList kết quả page.getOperatorList()
 * @param {Record<string, number>} OPS pdfjsLib.OPS
 * @param {number[]} view page.view = [x0, y0, x1, y1]
 * @returns {Table[]} lưới bảng, xs tăng dần (trái → phải), ys giảm dần (trên → dưới)
 */
export function findTables(opList, OPS, view) {
  const { hs, vs, fills } = findSegments(opList, OPS, view);
  const lined = buildTables(hs, vs);
  // bảng không kẻ đường (hay gặp trên slide): các ô tô màu xếp sát nhau thành lưới
  const tiled = buildRectGrids(fills).filter((t) => !lined.some((l) => overlaps(l.bbox, t.bbox)));
  return [...lined, ...tiled];
}

function overlaps(a, b) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** Các đoạn kẻ ngang/dọc trên trang, đã gộp các mẩu nối tiếp nhau. */
export function findSegments(opList, OPS, view) {
  const fillOnly = new Set([OPS.fill, OPS.eoFill]);
  const stroked = new Set([OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke]);
  const pageW = view[2] - view[0];
  const pageH = view[3] - view[1];
  const hs = [];
  const vs = [];
  const fills = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || ctm;
    else if (fn === OPS.transform) ctm = multiply(ctm, args);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) || ArrayBuffer.isView(args?.[0])) ctm = multiply(ctm, args[0]);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || ctm;
    else if (fn === OPS.constructPath) {
      const [op, data] = args;
      const path = data?.[0];
      if ((fillOnly.has(op) || stroked.has(op)) && path && typeof path.length === 'number') {
        collect(path, ctm, { hs, vs, fills }, pageW, pageH, stroked.has(op));
      }
    }
  }
  return { hs: mergeSegments(hs, 'y', 'x0', 'x1'), vs: mergeSegments(vs, 'x', 'y0', 'y1'), fills };
}

function multiply(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** Tách đường vẽ thành các nét con, rồi lấy đoạn ngang/dọc từ mỗi nét. */
function collect(path, ctm, out, pageW, pageH, isStroked) {
  let sub = null;
  const flush = () => {
    if (sub && sub.points.length > 1 && !sub.curved) addSubpath(sub, out, pageW, pageH, isStroked);
    sub = null;
  };
  for (let i = 0; i < path.length; ) {
    const code = path[i++];
    if (code === MOVE_TO) {
      flush();
      sub = { points: [apply(ctm, path[i], path[i + 1])], closed: false, curved: false };
      i += 2;
    } else if (code === LINE_TO) {
      sub?.points.push(apply(ctm, path[i], path[i + 1]));
      i += 2;
    } else if (code === CURVE_TO || code === QUAD_TO) {
      // góc bo tròn: không phải đường kẻ bảng
      if (sub) sub.curved = true;
      i += code === CURVE_TO ? 6 : 4;
    } else if (code === CLOSE) {
      if (sub) sub.closed = true;
    } else {
      return; // định dạng lạ: bỏ cả đường này còn hơn đọc sai
    }
  }
  flush();
}

function addSubpath({ points, closed }, { hs, vs, fills }, pageW, pageH, isStroked) {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  const isRect = (closed || points.length === 5) && points.length >= 4 && points.length <= 5 &&
    points.every(([x, y]) => (near(x, x0) || near(x, x1)) && (near(y, y0) || near(y, y1)));

  if (isRect) {
    const w = x1 - x0;
    const h = y1 - y0;
    // nền trang / khung lớn phủ gần hết trang không phải bảng
    if (w > pageW * 0.9 && h > pageH * 0.9) return;
    // ô vuông nhỏ có bề dày thật (checkbox, ký hiệu) xếp chồng thẳng hàng sẽ thành lưới giả;
    // mẩu đường kẻ mảnh ngắn thì giữ, vì bảng hay được vẽ nối từ nhiều mẩu như vậy
    if (w > THIN && h > THIN && w < 15 && h < 15) return;
    if (h <= THIN && w > THIN) hs.push({ y: (y0 + y1) / 2, x0, x1 });
    else if (w <= THIN && h > THIN) vs.push({ x: (x0 + x1) / 2, y0, y1 });
    // hình chữ nhật dày chỉ tô màu là nền ô (thường lùi vào trong viền vài pt), không phải
    // đường kẻ; chỉ hình chữ nhật có viền mới là khung ô
    else if (w > THIN && h > THIN && isStroked) {
      hs.push({ y: y0, x0, x1 }, { y: y1, x0, x1 });
      vs.push({ x: x0, y0, y1 }, { x: x1, y0, y1 });
    }
    else if (w > THIN && h > THIN) fills.push({ x0, y0, x1, y1 });
    return;
  }
  const pts = closed ? [...points, points[0]] : points;
  for (let i = 1; i < pts.length; i++) {
    const [ax, ay] = pts[i - 1];
    const [bx, by] = pts[i];
    if (Math.abs(ay - by) < 1 && Math.abs(ax - bx) > TOL) hs.push({ y: (ay + by) / 2, x0: Math.min(ax, bx), x1: Math.max(ax, bx) });
    else if (Math.abs(ax - bx) < 1 && Math.abs(ay - by) > TOL) vs.push({ x: (ax + bx) / 2, y0: Math.min(ay, by), y1: Math.max(ay, by) });
  }
}

function near(a, b) {
  return Math.abs(a - b) < 1;
}

/** Gộp các đoạn cùng hàng (hoặc cùng cột) nối tiếp/chồng lên nhau thành một đoạn dài. */
function mergeSegments(segs, pos, start, end) {
  const sorted = [...segs].sort((p, q) => p[pos] - q[pos] || p[start] - q[start]);
  const out = [];
  for (const s of sorted) {
    const last = out.at(-1);
    if (last && Math.abs(last[pos] - s[pos]) <= TOL && s[start] <= last[end] + TOL) {
      last[end] = Math.max(last[end], s[end]);
    } else {
      out.push({ ...s });
    }
  }
  return out.filter((s) => s[end] - s[start] > 4);
}

/** Nhóm đoạn ngang/dọc cắt nhau (union-find); nhóm đủ 3×3 đường kẻ thành một lưới bảng. */
function buildTables(hs, vs) {
  const all = [...hs.map((s) => ({ ...s, h: true })), ...vs.map((s) => ({ ...s, h: false }))];
  const parent = all.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < hs.length; i++) {
    for (let j = hs.length; j < all.length; j++) {
      const h = all[i];
      const v = all[j];
      if (v.x >= h.x0 - TOL && v.x <= h.x1 + TOL && h.y >= v.y0 - TOL && h.y <= v.y1 + TOL) {
        parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map();
  all.forEach((s, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(s);
  });

  const tables = [];
  for (const segs of groups.values()) {
    const h = segs.filter((s) => s.h);
    const v = segs.filter((s) => !s.h);
    const xs = clusterValues(v.map((s) => s.x)).sort((p, q) => p - q);
    const ys = clusterValues(h.map((s) => s.y)).sort((p, q) => q - p);
    if (xs.length < 3 || ys.length < 3) continue;
    // cột hẹp hơn ~một ký tự thì là hình vẽ chứ không phải bảng
    if (xs.some((x, i) => i > 0 && x - xs[i - 1] < 12)) continue;
    tables.push(makeTable(xs, ys, lineOwner(xs, ys, h, v), 'ruled'));
  }
  return tables;
}

function clusterValues(values) {
  const sorted = [...values].sort((p, q) => p - q);
  const out = [];
  for (const val of sorted) {
    if (out.length && val - out.at(-1) <= TOL) continue;
    out.push(val);
  }
  return out;
}

/**
 * @typedef {{ xs: number[], ys: number[], bbox: number[], cellAt: (x: number, y: number) => number | null, rows: number, cols: number }} Table
 */
function lineOwner(xs, ys, h, v) {
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  // có đường dọc ở x chạy qua tung độ y không (ranh giới giữa hai cột ở hàng đó)
  const hasV = (x, y) => v.some((s) => Math.abs(s.x - x) <= TOL && y >= s.y0 - TOL && y <= s.y1 + TOL);
  const hasH = (y, x) => h.some((s) => Math.abs(s.y - y) <= TOL && x >= s.x0 - TOL && x <= s.x1 + TOL);

  // ô gộp: thiếu ranh giới bên trái thì thuộc ô bên trái, thiếu ranh giới phía trên thì thuộc ô trên
  const owner = new Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    const midY = (ys[r] + ys[r + 1]) / 2;
    for (let c = 0; c < cols; c++) {
      const midX = (xs[c] + xs[c + 1]) / 2;
      let o = r * cols + c;
      if (c > 0 && !hasV(xs[c], midY)) o = owner[r * cols + c - 1];
      else if (r > 0 && !hasH(ys[r], midX)) o = owner[(r - 1) * cols + c];
      owner[r * cols + c] = o;
    }
  }
  return owner;
}

function makeTable(xs, ys, owner, kind) {
  const rows = ys.length - 1;
  const cols = xs.length - 1;
  return {
    /** 'ruled': có đường kẻ; 'tiled': ghép từ ô tô màu (cần kiểm tra chặt hơn khi có chữ) */
    kind,
    xs,
    ys,
    rows,
    cols,
    owner,
    bbox: [xs[0], ys.at(-1), xs.at(-1), ys[0]],
    /** Chỉ số ô (đã quy về ô gốc nếu bị gộp) chứa điểm (x, y), hoặc null nếu nằm ngoài bảng. */
    cellAt(x, y) {
      if (x < xs[0] - 1 || x > xs.at(-1) + 1 || y > ys[0] + 1 || y < ys.at(-1) - 1) return null;
      let c = xs.findIndex((_, i) => i < cols && x < xs[i + 1]);
      let r = ys.findIndex((_, i) => i < rows && y > ys[i + 1]);
      if (c < 0) c = cols - 1;
      if (r < 0) r = rows - 1;
      return owner[r * cols + c];
    },
  };
}

const GAP = 4; // khe trắng tối đa giữa hai ô tô màu liền kề

/**
 * Bảng dựng từ ô tô màu (cách "rect-backed" của pdf-inspector): gom các hình chữ nhật tô màu
 * nằm sát nhau, lấy mép ô làm ranh giới hàng/cột. Chỉ nhận khi các ô phủ gần kín lưới, để
 * vài thẻ (card) đặt cạnh nhau trên slide không bị coi là bảng.
 */
function buildRectGrids(fills) {
  const rects = fills.filter((r) => r.x1 - r.x0 > 12 && r.y1 - r.y0 > 6);
  const parent = rects.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const touch = (a, b) =>
    a.x0 <= b.x1 + GAP && b.x0 <= a.x1 + GAP && a.y0 <= b.y1 + GAP && b.y0 <= a.y1 + GAP;
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) if (touch(rects[i], rects[j])) parent[find(i)] = find(j);
  }
  const groups = new Map();
  rects.forEach((r, i) => {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(r);
  });

  const tables = [];
  for (const group of groups.values()) {
    if (group.length < 4) continue;
    // mép phải ô trái và mép trái ô phải cách nhau một khe: gộp làm một ranh giới
    const xs = clusterEdges(group.flatMap((r) => [r.x0, r.x1])).sort((p, q) => p - q);
    const ys = clusterEdges(group.flatMap((r) => [r.y0, r.y1])).sort((p, q) => q - p);
    const rows = ys.length - 1;
    const cols = xs.length - 1;
    if (rows < 2 || cols < 2) continue;

    // mỗi ô lưới thuộc hình tô màu phủ tâm của nó; ô tô màu trải nhiều ô lưới là ô gộp
    const owner = new Array(rows * cols);
    const firstCell = new Map();
    let covered = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cx = (xs[c] + xs[c + 1]) / 2;
        const cy = (ys[r] + ys[r + 1]) / 2;
        const idx = r * cols + c;
        const rect = group.find((g) => cx > g.x0 && cx < g.x1 && cy > g.y0 && cy < g.y1);
        if (!rect) {
          owner[idx] = idx;
          continue;
        }
        covered++;
        if (!firstCell.has(rect)) firstCell.set(rect, idx);
        owner[idx] = firstCell.get(rect);
      }
    }
    if (covered < rows * cols * 0.75) continue;
    tables.push(makeTable(xs, ys, owner, 'tiled'));
  }
  return tables;
}

function clusterEdges(values) {
  const sorted = [...values].sort((p, q) => p - q);
  const groups = [];
  for (const val of sorted) {
    const last = groups.at(-1);
    if (last && val - last.at(-1) <= GAP + 1) last.push(val);
    else groups.push([val]);
  }
  return groups.map((g) => (g[0] + g.at(-1)) / 2);
}
