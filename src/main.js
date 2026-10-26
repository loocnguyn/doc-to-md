import './style.css';
import { convertFile, isSupported } from './convert/index.js';

const input = document.getElementById('file-input');
const drop = document.getElementById('drop');
const list = document.getElementById('list');
const results = document.getElementById('results');
const downloadAllBtn = document.getElementById('download-all');
const clearBtn = document.getElementById('clear');
const optPages = document.getElementById('opt-pages');
const optNotes = document.getElementById('opt-notes');

/** @type {{ id: number, name: string, mdName: string, markdown?: string }[]} */
const done = [];
let nextId = 1;
// chuyển lần lượt từng file để không ngốn RAM khi thả nhiều file lớn cùng lúc
let queue = Promise.resolve();

input.addEventListener('change', () => {
  handleFiles(input.files);
  input.value = '';
});

for (const type of ['dragenter', 'dragover']) {
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  });
}
for (const type of ['dragleave', 'drop']) {
  drop.addEventListener(type, () => drop.classList.remove('over'));
}
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  handleFiles(e.dataTransfer.files);
});

clearBtn.addEventListener('click', () => {
  list.replaceChildren();
  done.length = 0;
  results.hidden = true;
  updateDownloadAll();
});

downloadAllBtn.addEventListener('click', async () => {
  const ready = done.filter((d) => d.markdown != null);
  if (ready.length === 1) return saveMarkdown(ready[0].mdName, ready[0].markdown);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set();
  for (const d of ready) zip.file(uniqueName(d.mdName, used), d.markdown);
  const blob = await zip.generateAsync({ type: 'blob' });
  saveBlob('markdown.zip', blob);
});

function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  results.hidden = false;
  for (const file of files) {
    const view = renderItem(file);
    queue = queue.then(() => processFile(file, view));
  }
}

async function processFile(file, view) {
  const entry = { id: nextId++, name: file.name, mdName: toMdName(file.name) };
  if (!isSupported(file.name)) {
    view.fail(unsupportedMessage(file.name));
    return;
  }
  view.status('Đang chuyển…');
  const started = performance.now();
  try {
    const out = await convertFile(file, {
      pageMarkers: optPages.checked,
      notes: optNotes.checked,
      onProgress: (p) => view.progress(p),
    });
    entry.markdown = out.markdown;
    done.push(entry);
    view.success(entry, out, performance.now() - started);
  } catch (err) {
    console.error(err);
    view.fail(friendlyError(err));
  }
  updateDownloadAll();
}

function renderItem(file) {
  const li = el('li', 'item');
  const row = el('div', 'item-row');
  const info = el('div');
  const name = el('div', 'item-name', file.name);
  const meta = el('div', 'item-meta', formatBytes(file.size));
  info.append(name, meta);
  const actions = el('div', 'item-actions');
  row.append(info, actions);
  const bar = el('div', 'progress');
  const fill = el('span');
  bar.append(fill);
  li.append(row, bar);
  list.append(li);

  return {
    status(text) {
      meta.textContent = `${formatBytes(file.size)} · ${text}`;
    },
    progress(p) {
      fill.style.width = `${Math.round(p * 100)}%`;
    },
    fail(message) {
      bar.remove();
      meta.replaceChildren(`${formatBytes(file.size)} · `, el('span', 'err', message));
    },
    success(entry, out, ms) {
      bar.remove();
      const chars = out.markdown.length;
      meta.replaceChildren(
        `${formatBytes(file.size)} → ${formatBytes(new Blob([out.markdown]).size)} · `,
        el('span', 'ok', 'Xong'),
        ` · ${out.unitCount} ${out.unitLabel} · ~${formatNumber(estimateTokens(chars))} token · ${(ms / 1000).toFixed(1)}s`,
      );
      for (const w of out.warnings) li.append(el('p', 'warn', w));

      const dl = button('Tải .md', () => saveMarkdown(entry.mdName, entry.markdown));
      const copy = button('Sao chép', async () => {
        await navigator.clipboard.writeText(entry.markdown);
        flash(copy, 'Đã chép');
      }, true);
      let pre;
      const toggle = button('Xem trước', () => {
        if (pre) {
          pre.remove();
          pre = null;
          toggle.textContent = 'Xem trước';
          return;
        }
        pre = el('pre', 'preview');
        // chỉ hiện phần đầu để trang không bị đơ với file rất dài
        const limit = 20000;
        pre.textContent = entry.markdown.length > limit
          ? `${entry.markdown.slice(0, limit)}\n\n… (còn ${formatNumber(entry.markdown.length - limit)} ký tự, tải file để xem đủ)`
          : entry.markdown;
        li.append(pre);
        toggle.textContent = 'Ẩn';
      }, true);
      actions.append(dl, copy, toggle);
    },
  };
}

function updateDownloadAll() {
  const n = done.filter((d) => d.markdown != null).length;
  downloadAllBtn.disabled = n === 0;
  downloadAllBtn.textContent = n > 1 ? `Tải tất cả (.zip, ${n} file)` : 'Tải tất cả';
}

function saveMarkdown(name, markdown) {
  saveBlob(name, new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
}

function saveBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function toMdName(name) {
  return name.replace(/\.[^.]+$/, '') + '.md';
}

function uniqueName(name, used) {
  let candidate = name;
  for (let i = 2; used.has(candidate); i++) candidate = name.replace(/\.md$/, ` (${i}).md`);
  used.add(candidate);
  return candidate;
}

function unsupportedMessage(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'doc') return 'File .doc cũ chưa hỗ trợ. Mở bằng Word và lưu lại thành .docx.';
  if (ext === 'ppt') return 'File .ppt cũ chưa hỗ trợ. Mở bằng PowerPoint và lưu lại thành .pptx.';
  return 'Định dạng chưa hỗ trợ (chỉ PDF, DOCX, PPTX).';
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/password/i.test(msg)) return 'PDF có mật khẩu, hãy gỡ mật khẩu rồi thử lại.';
  if (/Invalid PDF|corrupted|end of central directory|zip/i.test(msg)) return 'File bị hỏng hoặc không đúng định dạng.';
  return `Lỗi: ${msg}`;
}

// tiếng Việt có dấu tốn token hơn tiếng Anh, ~3 ký tự/token là ước lượng thận trọng
function estimateTokens(chars) {
  return Math.round(chars / 3);
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function formatNumber(n) {
  return n.toLocaleString('vi-VN');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, onClick, ghost = false) {
  const b = el('button', ghost ? 'btn ghost' : 'btn', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}
