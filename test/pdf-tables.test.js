import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findTables } from '../src/convert/pdf-tables.js';

// mã lệnh giả: findTables chỉ so sánh với bảng OPS truyền vào
const OPS = {
  save: 1, restore: 2, transform: 3, constructPath: 4, paintFormXObjectBegin: 5, paintFormXObjectEnd: 6,
  stroke: 10, closeStroke: 11, fill: 12, eoFill: 13, fillStroke: 14, eoFillStroke: 15,
  closeFillStroke: 16, closeEOFillStroke: 17,
};
const VIEW = [0, 0, 600, 800];

const rect = (x, y, w, h) => [0, x, y, 1, x + w, y, 1, x + w, y + h, 1, x, y + h, 4];
const line = (x0, y0, x1, y1) => [0, x0, y0, 1, x1, y1];

function opList(paths) {
  return {
    fnArray: paths.map(() => OPS.constructPath),
    argsArray: paths.map(([op, path]) => [op, [new Float32Array(path)], null]),
  };
}

test('lưới kẻ đường 2×2 thành một bảng', () => {
  const paths = [];
  for (const y of [100, 130, 160]) paths.push([OPS.stroke, line(50, y, 350, y)]);
  for (const x of [50, 200, 350]) paths.push([OPS.stroke, line(x, 100, x, 160)]);
  const tables = findTables(opList(paths), OPS, VIEW);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].xs, [50, 200, 350]);
  assert.deepEqual(tables[0].ys, [160, 130, 100]);
  assert.equal(tables[0].cellAt(100, 150), 0);
  assert.equal(tables[0].cellAt(300, 110), 3);
  assert.equal(tables[0].cellAt(400, 110), null);
});

test('thiếu đường dọc giữa hai ô thì là ô gộp', () => {
  const paths = [];
  for (const y of [100, 130, 160]) paths.push([OPS.stroke, line(50, y, 350, y)]);
  paths.push([OPS.stroke, line(50, 100, 50, 160)], [OPS.stroke, line(350, 100, 350, 160)]);
  // đường dọc giữa chỉ có ở hàng dưới
  paths.push([OPS.stroke, line(200, 100, 200, 130)]);
  const [t] = findTables(opList(paths), OPS, VIEW);
  assert.equal(t.cellAt(300, 150), 0, 'hàng trên gộp hai cột');
  assert.equal(t.cellAt(300, 110), 3, 'hàng dưới vẫn tách');
});

test('nền ô chỉ tô màu không tạo đường kẻ', () => {
  const paths = [];
  for (const y of [100, 130, 160]) paths.push([OPS.fill, rect(50, y, 300, 0.5)]);
  for (const x of [50, 200, 350]) paths.push([OPS.fill, rect(x, 100, 0.5, 60)]);
  // nền ô lùi vào trong viền 5pt: nếu tính cạnh của nó sẽ thành cột hẹp 5pt
  paths.push([OPS.fill, rect(55, 135, 140, 20)], [OPS.fill, rect(205, 135, 140, 20)]);
  const tables = findTables(opList(paths), OPS, VIEW);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].xs.map(Math.round), [50, 200, 350]);
});

test('ô tô màu xếp sát nhau (bảng trên slide) thành bảng', () => {
  const paths = [];
  // 3 hàng × 2 cột, khe trắng 2–3pt giữa các ô
  for (const y of [160, 131, 102]) {
    for (const x of [50, 201]) paths.push([OPS.fill, rect(x, y, 148, 27)]);
  }
  const tables = findTables(opList(paths), OPS, VIEW);
  assert.equal(tables.length, 1);
  assert.equal(tables[0].kind, 'tiled');
  assert.equal(tables[0].rows, 3);
  assert.equal(tables[0].cols, 2);
});

test('thẻ cách xa nhau và ô vuông checkbox không phải bảng', () => {
  const cards = [[OPS.fill, rect(50, 100, 150, 80)], [OPS.fill, rect(230, 100, 150, 80)], [OPS.fill, rect(50, 210, 150, 80)], [OPS.fill, rect(230, 210, 150, 80)]];
  assert.equal(findTables(opList(cards), OPS, VIEW).length, 0);
  const boxes = [];
  for (let i = 0; i < 6; i++) boxes.push([OPS.stroke, rect(60, 100 + i * 12, 9, 9)]);
  assert.equal(findTables(opList(boxes), OPS, VIEW).length, 0);
});
