#!/usr/bin/env node
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const KB_DIR = join(process.cwd(), 'skills', 'interlink-knowledge', 'kb');
const INDEX_PATH = join(KB_DIR, 'INDEX.md');
const MAX_ANSWER_CHARS = 1200;
const MAX_FILE_BYTES = 12 * 1024;
const STALE_DAYS = 180;

const errors = [];
const warnings = [];

await main();

async function main() {
  if (!existsSync(INDEX_PATH)) {
    error('index-missing', 'kb/INDEX.md');
    finish(0, 0, 0);
  }

  let entries = [];
  let indexText = '';
  try {
    entries = await readdir(KB_DIR);
    indexText = await readFile(INDEX_PATH, 'utf8');
  } catch (err) {
    error('index-missing', `kb/INDEX.md (${err.message})`);
    finish(0, 0, 0);
  }

  const index = parseIndex(indexText);
  const listedFiles = new Set(index.map(item => item.file));
  const fileCounts = new Map();
  for (const item of index) {
    fileCounts.set(item.file, (fileCounts.get(item.file) ?? 0) + 1);
  }
  for (const [file, count] of fileCounts) {
    if (count > 1) error('dup-file', `kb/${file}`);
  }

  const mdFiles = entries.filter(name => name.endsWith('.md'));
  for (const item of index) {
    if (!mdFiles.includes(item.file)) error('missing-file', `kb/${item.file}`);
  }
  for (const file of mdFiles) {
    if (file === 'INDEX.md' || file.startsWith('_')) continue;
    if (!listedFiles.has(file)) error('unlisted-file', `kb/${file}`);
  }

  warnDuplicateKeywords(index);

  let sectionCount = 0;
  for (const item of index) {
    if (!mdFiles.includes(item.file)) continue;
    const fullPath = join(KB_DIR, item.file);
    const st = await stat(fullPath);
    if (st.size > MAX_FILE_BYTES) warn('big-file', `kb/${item.file} (${st.size} bytes)`);

    const text = await readFile(fullPath, 'utf8');
    warnIfStale(item.file, text);
    const sections = parseSections(text);
    if (sections.length === 0) {
      error('no-section', `kb/${item.file}`);
      continue;
    }
    sectionCount += sections.length;
    for (const section of sections) {
      if (!section.trigger || !section.answer.trim()) {
        error('section-missing-key', `kb/${item.file}#${section.title}`);
      }
      if (section.answer.length > MAX_ANSWER_CHARS) {
        warn('long-answer', `kb/${item.file}#${section.title} (${section.answer.length} chars)`);
      }
    }
  }

  const keywordCount = index.reduce((sum, item) => sum + item.keywords.length, 0);
  finish(index.length, sectionCount, keywordCount);
}

function parseIndex(text) {
  const rows = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, idx) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    if (!line.includes(' :: ')) {
      error('bad-line', `INDEX.md:${idx + 1}`);
      return;
    }
    const [filePart, keywordsPart] = line.split(' :: ', 2);
    const file = filePart.trim();
    const keywords = keywordsPart.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (!file || keywords.length === 0) {
      error('bad-line', `INDEX.md:${idx + 1}`);
      return;
    }
    rows.push({ file, keywords, line: idx + 1 });
  });
  return rows;
}

function parseSections(text) {
  const lines = text.split(/\r?\n/);
  const starts = [];
  lines.forEach((line, idx) => {
    if (line.startsWith('## ')) starts.push(idx);
  });

  return starts.map((start, i) => {
    const end = starts[i + 1] ?? lines.length;
    const block = lines.slice(start, end);
    const title = block[0].replace(/^##\s+/, '').trim();
    let trigger = '';
    const answerLines = [];
    let inAnswer = false;

    for (let j = 1; j < block.length; j++) {
      const line = block[j];
      if (line.startsWith('TRIGGER:')) {
        trigger = line.slice('TRIGGER:'.length).trim();
        inAnswer = false;
        continue;
      }
      if (line.startsWith('ANSWER:')) {
        const inline = line.slice('ANSWER:'.length).trim();
        if (inline) answerLines.push(inline);
        inAnswer = true;
        continue;
      }
      if (/^[A-Z_]+:/.test(line)) {
        inAnswer = false;
        continue;
      }
      if (inAnswer) answerLines.push(line);
    }

    return { title, trigger, answer: answerLines.join('\n').trim() };
  });
}

function warnDuplicateKeywords(index) {
  const ownerByKeyword = new Map();
  for (const item of index) {
    for (const keyword of item.keywords) {
      const owner = ownerByKeyword.get(keyword);
      if (owner && owner !== item.file) {
        warn('dup-keyword', `${keyword} (${owner}, ${item.file})`);
      } else {
        ownerByKeyword.set(keyword, item.file);
      }
    }
  }
}

function warnIfStale(file, text) {
  const match = text.match(/^UPDATED:\s*(\d{4}-\d{2}-\d{2})\s*$/m);
  if (!match) return;
  const updated = new Date(`${match[1]}T00:00:00Z`);
  if (Number.isNaN(updated.getTime())) return;
  const ageDays = (Date.now() - updated.getTime()) / 86_400_000;
  if (ageDays > STALE_DAYS) warn('stale', `kb/${file} UPDATED ${match[1]}`);
}

function error(code, detail) {
  errors.push(`ERROR ${code}: ${detail}`);
}

function warn(code, detail) {
  warnings.push(`WARN ${code}: ${detail}`);
}

function finish(fileCount, sectionCount, keywordCount) {
  for (const line of warnings) console.log(line);
  for (const line of errors) console.error(line);
  if (errors.length > 0) process.exit(1);
  console.log(`KB OK — ${fileCount} files, ${sectionCount} sections, ${keywordCount} keywords`);
}
