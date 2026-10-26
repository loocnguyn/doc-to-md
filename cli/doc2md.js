#!/usr/bin/env node
import './node-env.js';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { convertFile, isSupported } from '../src/convert/index.js';

const HELP = `doc2md: convert PDF, DOCX, PPTX, DOC, PPT, XLS and XLSX files to Markdown

Usage:
  doc2md <file...> [options]

Options:
  -o, --out <dir>   Where to write the .md files (default: next to each input)
      --stdout      Print Markdown to stdout instead of writing a file (single input only)
      --no-pages    Leave out <!-- page N --> / <!-- slide N --> markers
      --no-notes    Leave out PowerPoint speaker notes
      --no-ocr      Do not OCR scanned PDF pages
  -h, --help        Show this help

Examples:
  doc2md lecture.pdf
  doc2md slides/*.pptx -o md/
  doc2md syllabus.docx --stdout`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', short: 'o' },
    stdout: { type: 'boolean', default: false },
    'no-pages': { type: 'boolean', default: false },
    'no-notes': { type: 'boolean', default: false },
    'no-ocr': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help || !positionals.length) {
  console.log(HELP);
  process.exit(values.help ? 0 : 1);
}
if (values.stdout && positionals.length > 1) {
  console.error('--stdout works with a single input file only.');
  process.exit(1);
}

let failed = 0;
for (const input of positionals) {
  const path = resolve(input);
  const name = basename(path);
  if (!isSupported(name)) {
    console.error(`✗ ${name}: unsupported file type`);
    failed++;
    continue;
  }
  const started = performance.now();
  try {
    const file = new File([await readFile(path)], name);
    const out = await convertFile(file, {
      pageMarkers: !values['no-pages'],
      notes: !values['no-notes'],
      ocr: !values['no-ocr'],
      onStatus: (s) => process.stderr.write(`  ${name}: ${s}\n`),
    });

    if (values.stdout) {
      process.stdout.write(out.markdown);
    } else {
      const dir = values.out ? resolve(values.out) : dirname(path);
      await mkdir(dir, { recursive: true });
      const target = join(dir, basename(name, extname(name)) + '.md');
      await writeFile(target, out.markdown, 'utf8');
      const secs = ((performance.now() - started) / 1000).toFixed(1);
      const tokens = Math.round(out.markdown.length / 3).toLocaleString('en-US');
      console.error(`✓ ${name} → ${target} (${out.unitCount} ${out.unitLabel}, ~${tokens} tokens, ${secs}s)`);
    }
    for (const w of out.warnings) console.error(`  ! ${w}`);
  } catch (err) {
    console.error(`✗ ${name}: ${err?.message || err}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
