import './style.css';
import './browser-env.js';
import { convertFile, isSupported, ACCEPT } from './convert/index.js';

const input = document.getElementById('file-input');
const drop = document.getElementById('drop');
const list = document.getElementById('list');
const results = document.getElementById('results');
const downloadAllBtn = document.getElementById('download-all');
const clearBtn = document.getElementById('clear');
const optPages = document.getElementById('opt-pages');
const optNotes = document.getElementById('opt-notes');
const optOcr = document.getElementById('opt-ocr');

input.accept = ACCEPT;

/** @type {{ name: string, mdName: string, markdown: string }[]} */
const done = [];
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
  if (done.length === 1) return saveMarkdown(done[0].mdName, done[0].markdown);
  const { default: JSZip } = await import('jszip');
  const zip = new JSZip();
  const used = new Set();
  for (const d of done) zip.file(uniqueName(d.mdName, used), d.markdown);
  saveBlob('markdown.zip', await zip.generateAsync({ type: 'blob' }));
});

function handleFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length) return;
  results.hidden = false;
  for (const file of files) {
    const row = renderRow(file);
    queue = queue.then(() => processFile(file, row));
  }
}

async function processFile(file, row) {
  if (!isSupported(file.name)) {
    row.fail(unsupportedMessage(file.name));
    return;
  }
  row.busy('Converting…');
  const started = performance.now();
  try {
    const out = await convertFile(file, {
      pageMarkers: optPages.checked,
      notes: optNotes.checked,
      ocr: optOcr.checked,
      onProgress: (p) => row.progress(p),
      onStatus: (s) => row.busy(s),
    });
    const entry = { name: file.name, mdName: toMdName(file.name), markdown: out.markdown };
    done.push(entry);
    row.success(entry, out, performance.now() - started);
  } catch (err) {
    console.error(err);
    row.fail(friendlyError(err));
  }
  updateDownloadAll();
}

function renderRow(file) {
  const tr = el('tr');
  const name = el('td', 'col-name', file.name);
  const size = el('td', 'col-size', formatBytes(file.size));
  const result = el('td', 'col-result');
  const actions = el('td', 'col-actions');
  tr.append(name, size, result, actions);
  list.append(tr);

  const state = el('span', 'state busy', 'Queued');
  const detail = el('span', 'detail');
  const bar = el('div', 'progress');
  const fill = el('span');
  bar.append(fill);
  result.append(state, detail);

  let previewRow = null;

  return {
    busy(text) {
      state.className = 'state busy';
      state.textContent = text;
      if (!bar.isConnected) result.append(bar);
    },
    progress(p) {
      fill.style.width = `${Math.round(p * 100)}%`;
    },
    fail(message) {
      bar.remove();
      state.className = 'state err';
      state.textContent = 'Failed';
      detail.textContent = message;
    },
    success(entry, out, ms) {
      bar.remove();
      state.className = 'state ok';
      state.textContent = 'Done';
      const units = typeof out.unitCount === 'number' ? `${formatNumber(out.unitCount)} ${out.unitLabel} · ` : '';
      detail.textContent =
        `${units}~${formatNumber(estimateTokens(out.markdown.length))} tokens · ` +
        `${formatBytes(new Blob([out.markdown]).size)} · ${(ms / 1000).toFixed(1)}s`;
      for (const w of out.warnings) result.append(el('span', 'warn', w));

      const dl = button('Download', () => saveMarkdown(entry.mdName, entry.markdown));
      const copy = button('Copy', async () => {
        await navigator.clipboard.writeText(entry.markdown);
        flash(copy, 'Copied');
      }, true);
      const toggle = button('Preview', () => {
        if (previewRow) {
          previewRow.remove();
          previewRow = null;
          toggle.textContent = 'Preview';
          return;
        }
        previewRow = el('tr', 'preview-row');
        const cell = el('td');
        cell.colSpan = 4;
        const pre = el('pre', 'preview');
        // chỉ hiện phần đầu để trang không bị đơ với file rất dài
        const limit = 20000;
        pre.textContent = entry.markdown.length > limit
          ? `${entry.markdown.slice(0, limit)}\n\n… ${formatNumber(entry.markdown.length - limit)} more characters. Download the file to see everything.`
          : entry.markdown;
        cell.append(pre);
        previewRow.append(cell);
        tr.after(previewRow);
        toggle.textContent = 'Hide';
      }, true);
      actions.append(dl, copy, toggle);
    },
  };
}

function updateDownloadAll() {
  downloadAllBtn.disabled = done.length === 0;
  downloadAllBtn.textContent = done.length > 1 ? `Download all (.zip, ${done.length})` : 'Download all';
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
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  return ext ? `.${ext} files are not supported yet.` : 'Unknown file type.';
}

function friendlyError(err) {
  const msg = String(err?.message || err);
  if (/password/i.test(msg)) return 'This PDF is password-protected. Remove the password and try again.';
  if (/Invalid PDF|corrupted|end of central directory|zip/i.test(msg)) return 'The file looks damaged or is not the format its extension says.';
  return msg;
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
  return n.toLocaleString('en-US');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, onClick, secondary = false) {
  const b = el('button', secondary ? 'btn small secondary' : 'btn small', label);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

function flash(btn, text) {
  const old = btn.textContent;
  btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}
