import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMixedSegmenter, splitSyllables } from '../src/convert/segment.js';

const seg = createMixedSegmenter(readFileSync(new URL('../src/convert/data/words-en.txt', import.meta.url), 'utf8'));
const split = (s) => (seg([...s]) || []).join(' ');

test('tiếng Việt thuần', () => {
  assert.equal(split('CHƯƠNG'), 'CHƯƠNG');
  assert.equal(split('BÀIGIẢNG'), 'BÀI GIẢNG');
  assert.equal(split('NỘIDUNGPHẦN'), 'NỘI DUNG PHẦN');
  assert.equal(split('QUYTRÌNHBÀNGIAO'), 'QUY TRÌNH BÀN GIAO');
  assert.equal(split('TƯDUYTỔCHỨCKHAITHÁCVẬNTẢIĐAPHƯƠNGTHỨC'), 'TƯ DUY TỔ CHỨC KHAI THÁC VẬN TẢI ĐA PHƯƠNG THỨC');
  assert.equal(split('TRUNGTAMDAOTAO'), 'TRUNG TAM DAO TAO');
});

test('tiếng Anh', () => {
  assert.equal(split('CASESTUDY'), 'CASE STUDY');
  assert.equal(split('TABLEOFCONTENTS'), 'TABLE OF CONTENTS');
  assert.equal(split('SEAAIRANDROADFREIGHT'), 'SEA AIR AND ROAD FREIGHT');
});

test('lẫn Việt–Anh và viết tắt', () => {
  assert.equal(split('KIỂMSOÁTCARGOREADINESSVÀEQUIPMENTREADINESS'), 'KIỂM SOÁT CARGO READINESS VÀ EQUIPMENT READINESS');
  assert.equal(split('INCOTERMSVÀPHÂNCHIANGHĨAVỤTRONGVTĐPT'), 'INCOTERMS VÀ PHÂN CHIA NGHĨA VỤ TRONG VTĐPT');
  assert.equal(split('ĐỊNHNGHĨARACI'), 'ĐỊNH NGHĨA RACI');
  assert.equal(split('KPIVÀRỦIRO'), 'KPI VÀ RỦI RO');
  assert.equal(split('TRUNGTÂMLOGISTICS'), 'TRUNG TÂM LOGISTICS');
});

test('luật chính tả phụ âm đầu', () => {
  // "ng" không đứng trước i/e (phải là "ngh") nên "BÀNGIAO" là "BÀN GIAO"
  assert.deepEqual(splitSyllables([...'BÀNGIAO']), ['BÀN', 'GIAO']);
  assert.deepEqual(splitSyllables([...'NGHĨAVỤ']), ['NGHĨA', 'VỤ']);
});
