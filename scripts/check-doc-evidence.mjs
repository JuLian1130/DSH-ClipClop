#!/usr/bin/env node
// 文档取证 lint：只查本次改动新增的 Markdown 行，避免历史欠账把门禁淹掉。
// 规则来源：docs/agents/issue-tracker.md「票面落修的取证纪律」与「代码复审的收敛判据」。
//
// 用法：
//   node scripts/check-doc-evidence.mjs                    # 查主仓未提交/已暂存的改动（相对 HEAD）
//   node scripts/check-doc-evidence.mjs --range A...B      # CI：查 A...B 的新增行
//   node scripts/check-doc-evidence.mjs --repo .scratch    # 查票据仓的改动（本地用）
//
// 某一行确实要展示被禁止的形状时，在该行写 `doc-evidence:ignore` 标记。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const readArg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const repo = path.resolve(readArg('--repo') ?? process.cwd());
const range = readArg('--range') ?? 'HEAD';

if (!existsSync(repo)) {
  console.error(`doc-evidence: repo not found: ${repo}`);
  process.exit(2);
}

const git = (args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });

let diff;
try {
  diff = git(['diff', range, '--unified=0', '--diff-filter=ACMR', '--', '*.md']);
} catch (error) {
  console.error(`doc-evidence: cannot diff ${range}: ${error.message}`);
  process.exit(2);
}

const rules = [
  {
    id: 'copied-test-count',
    severity: 'error',
    test: (line) =>
      /\d+\s*文件\s*\/\s*\d+\s*用例/.test(line) ||
      /\bpnpm test\b[^\n]*\d+\s*(文件|用例)/.test(line),
    message: '不要抄测试文件数/用例数；写「pnpm test 全绿」即可',
  },
  {
    id: 'test-line-ref',
    severity: 'error',
    test: (line) => /tests\/[^\s`"'）)】]+\.spec\.tsx?:\d+/.test(line),
    message: '测试引用用「文件 + it(...) 标题」，不写行号',
  },
  {
    id: 'count-without-denominator',
    severity: 'warning',
    test: (line) =>
      /(condensed|abstained|not-shorter)/.test(line) &&
      /\d/.test(line) &&
      !/(分母|口径)/.test(line),
    message: '语料计数需要分母/口径',
  },
];

const errors = [];
const warnings = [];

const checkLine = (file, lineNo, line) => {
  if (line.includes('doc-evidence:ignore')) return;
  for (const rule of rules) {
    if (!rule.test(line)) continue;
    const hit = {
      file,
      line: lineNo,
      rule: rule.id,
      message: rule.message,
      text: line.trim().slice(0, 160),
    };
    (rule.severity === 'error' ? errors : warnings).push(hit);
  }
};

// 已跟踪文件：只看 diff 的新增行。
let current = null;
let nextLine = 0;
for (const raw of diff.split('\n')) {
  if (raw.startsWith('+++ b/')) {
    current = raw.slice(6);
    continue;
  }
  if (raw.startsWith('+++ /dev/null')) {
    current = null;
    continue;
  }
  const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
  if (hunk) {
    nextLine = Number(hunk[1]);
    continue;
  }
  if (current === null) continue;
  if (raw.startsWith('+')) {
    checkLine(current, nextLine, raw.slice(1));
    nextLine += 1;
  } else if (raw.startsWith(' ')) {
    nextLine += 1;
  }
}

// 未跟踪的新文件：整文件扫（本地有用；CI 里通常没有）。
let untracked = [];
try {
  untracked = git(['ls-files', '--others', '--exclude-standard', '--', '*.md'])
    .split('\n')
    .filter(Boolean);
} catch {
  untracked = [];
}
for (const file of untracked) {
  const abs = path.join(repo, file);
  if (!existsSync(abs)) continue;
  readFileSync(abs, 'utf8')
    .split('\n')
    .forEach((line, i) => checkLine(file, i + 1, line));
}

const display = (file) => path.relative(process.cwd(), path.join(repo, file)) || file;
for (const hit of errors) {
  console.error(`ERROR ${display(hit.file)}:${hit.line} [${hit.rule}] ${hit.message}`);
  console.error(`      ${hit.text}`);
}
for (const hit of warnings) {
  console.error(`WARN  ${display(hit.file)}:${hit.line} [${hit.rule}] ${hit.message}`);
  console.error(`      ${hit.text}`);
}

const files = new Set([...errors, ...warnings].map((hit) => hit.file));
if (errors.length === 0 && warnings.length === 0) {
  console.log(`doc-evidence: ok (${range})`);
} else {
  console.log(`doc-evidence: ${errors.length} error(s), ${warnings.length} warning(s) in ${files.size} file(s)`);
}
process.exit(errors.length > 0 ? 1 : 0);
