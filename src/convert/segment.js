/**
 * Tách lại chuỗi chữ bị mất khoảng trắng ("CHƯƠNGBÀIGIẢNG", "CASESTUDY") thành từ.
 * - splitSyllables: chỉ tiếng Việt, theo cấu trúc phụ âm đầu + vần + phụ âm cuối.
 * - createMixedSegmenter: lẫn Việt–Anh, quy hoạch động như keredson/wordninja
 *   (chi phí từ tiếng Anh theo thứ hạng tần suất, luật Zipf) cộng thêm âm tiết tiếng Việt.
 */

const ONSETS = new Set(['ngh', 'ng', 'nh', 'ch', 'gh', 'gi', 'kh', 'ph', 'qu', 'th', 'tr',
  'b', 'c', 'd', 'đ', 'g', 'h', 'k', 'l', 'm', 'n', 'p', 'q', 'r', 's', 't', 'v', 'x']);
const CODAS = new Set(['ch', 'ng', 'nh', 'c', 'm', 'n', 'p', 't']);

export function baseLetters(s) {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function isVowel(ch) {
  return /[aeiouy]/.test(baseLetters(ch));
}

/** Luật chính tả: "nghi" chứ không "ngi", "ki/ke" chứ không "ci/ce", "gh"/"ngh" chỉ trước i, e. */
function validOnset(onset, vowel) {
  if (!ONSETS.has(onset)) return false;
  const front = /^[iey]/.test(vowel);
  if (onset === 'ng' || onset === 'c') return !front;
  if (onset === 'k' || onset === 'gh' || onset === 'ngh') return front;
  if (onset === 'q') return vowel.startsWith('u');
  return true;
}

function groupsOf(letters) {
  const groups = [];
  for (const ch of letters) {
    const vowel = isVowel(ch);
    const last = groups.at(-1);
    if (last && last.vowel === vowel) last.s += ch;
    else groups.push({ vowel, s: ch });
  }
  return groups;
}

/** Tách chuỗi chữ cái thành âm tiết tiếng Việt; trả về null nếu không tách hợp lệ được. */
export function splitSyllables(letters) {
  const groups = groupsOf(letters);
  if (!groups.some((g) => g.vowel)) return null;

  const syllables = [];
  let cur = '';
  for (let i = 0; i < groups.length; i++) {
    const { vowel, s } = groups[i];
    if (vowel) {
      if (s.length > 3) return null;
      cur += s;
      continue;
    }
    const lc = baseLetters(s);
    if (i === 0) {
      if (!ONSETS.has(lc)) return null;
      cur += s;
      continue;
    }
    if (i === groups.length - 1) {
      if (!CODAS.has(lc)) return null;
      cur += s;
      continue;
    }
    // cụm phụ âm giữa hai vần: ưu tiên phụ âm đầu dài nhất cho âm tiết sau
    const nextVowel = baseLetters(groups[i + 1].s);
    let split = -1;
    for (let len = Math.min(3, s.length); len >= 0; len--) {
      const onset = lc.slice(s.length - len);
      const coda = lc.slice(0, s.length - len);
      if ((len === 0 || validOnset(onset, nextVowel)) && (coda === '' || CODAS.has(coda))) {
        split = s.length - len;
        break;
      }
    }
    if (split < 0) return null;
    syllables.push(cur + s.slice(0, split));
    cur = s.slice(split);
  }
  syllables.push(cur);
  return syllables;
}

/**
 * @param {string} wordsText danh sách từ tiếng Anh, mỗi dòng một từ, xếp theo tần suất giảm dần
 * @returns {(letters: string[]) => string[]}
 */
export function createMixedSegmenter(wordsText) {
  const words = wordsText.split('\n').map((w) => w.trim()).filter(Boolean);
  const logN = Math.log(words.length);
  const cost = new Map();
  words.forEach((w, i) => {
    if (!cost.has(w)) cost.set(w, Math.log((i + 1) * logN));
  });
  const maxLen = 40;

  // Mỗi mảnh là một cụm: từ tiếng Anh, từ viết tắt, hoặc cả một cụm tiếng Việt. Quy hoạch động
  // chỉ chọn ranh giới giữa các cụm; trong cụm tiếng Việt, splitSyllables tách theo luật
  // phụ âm đầu dài nhất. Nếu để quy hoạch động chọn từng âm tiết (chi phí như nhau) nó sẽ
  // ưu tiên ít âm tiết, ra "VÀP HÂN CHIANG" thay vì "VÀ PHÂN CHIA NGHĨA".
  // mỗi mảnh cộng thêm một khoản cố định để ưu tiên ít mảnh ("INCOTERMS" hơn "IN CO TERMS");
  // mảnh một chữ cái ("I", "A") rẻ bất thường trong từ điển nên phạt thêm
  const withOverhead = (p, len) => p && { ...p, cost: p.cost + 1.5 + (len === 1 ? 6 : 0) };

  function piece(letters) {
    const s = letters.join('');
    const lower = s.toLowerCase();
    const ascii = /^[a-z]+$/.test(lower);
    if (ascii && cost.has(lower)) return { cost: cost.get(lower), words: [s] };
    const options = [];
    const syllables = splitSyllables(letters);
    if (syllables) options.push({ cost: 4 + syllables.reduce((sum, syl) => sum + syllableCost(syl), 0), words: syllables });
    // từ không có trong từ điển (viết tắt như RACI, INCOTERMS) hoặc viết tắt tiếng Việt toàn
    // phụ âm ("VTĐPT"): cho phép nhưng đắt dần theo độ dài để không nuốt cả chuỗi
    if ((ascii && s.length <= 12) || (s.length <= 8 && !letters.some(isVowel))) {
      options.push({ cost: 10 + 1.6 * s.length, words: [s] });
    }
    // "RACI" vừa là từ viết tắt vừa tách được thành "RAC I": lấy phương án rẻ hơn
    return options.sort((p, q) => p.cost - q.cost)[0] || null;
  }

  // Âm tiết có dấu gần như chắc chắn là tiếng Việt: rẻ và tính theo chữ cái (không theo số âm
  // tiết) để cách cắt cụm nào cũng tốn như nhau, cụm dài nhất thắng nhờ khoản cố định.
  // Âm tiết không dấu dễ trùng tiếng Anh ("SEA", "CASE") nên đắt ngang từ tiếng Anh;
  // âm tiết chỉ một nguyên âm không dấu ("I", "A") hiếm trong tiếng Việt nên phạt thêm.
  function syllableCost(syl) {
    if (/[^a-z]/i.test(syl)) return 0.5 * syl.length;
    return 3 + 1.4 * syl.length + ([...syl].every(isVowel) ? 9 : 0);
  }

  return (letters) => {
    const n = letters.length;
    const best = new Array(n + 1).fill(Infinity);
    const from = new Array(n + 1).fill(null);
    best[0] = 0;
    for (let i = 1; i <= n; i++) {
      for (let k = 1; k <= Math.min(i, maxLen); k++) {
        if (best[i - k] === Infinity) continue;
        const p = withOverhead(piece(letters.slice(i - k, i)), k);
        if (p && best[i - k] + p.cost < best[i]) {
          best[i] = best[i - k] + p.cost;
          from[i] = { start: i - k, words: p.words };
        }
      }
    }
    if (best[n] === Infinity) return null;
    const out = [];
    for (let i = n; i > 0; i = from[i].start) out.unshift(...from[i].words);
    return out;
  };
}
