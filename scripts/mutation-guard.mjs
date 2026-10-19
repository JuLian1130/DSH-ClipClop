#!/usr/bin/env node
// 本地运行：node scripts/mutation-guard.mjs。每次只在临时包副本里应用一项变异。
import { spawnSync } from 'node:child_process';
import { closeSync, cpSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const mutations = [
  {
    label: '-w lookaround',
    file: 'src/grepline.ts',
    find: "  if (flags.has('w')) body = `(?<!\\\\w)(?:${body})(?!\\\\w)`",
    replace: '',
  },
  {
    label: '-F 的 | 转义',
    file: 'src/grepline.ts',
    find: '/[.*+?^${}()|[\\]\\\\]/g',
    replace: '/[.*+?^${}()[\\]\\\\]/g',
  },
  {
    label: '-F 的括号转义',
    file: 'src/grepline.ts',
    find: '/[.*+?^${}()|[\\]\\\\]/g',
    replace: '/[.*+?^${}|[\\]\\\\]/g',
  },
  {
    label: '顶层拆分',
    file: 'src/grepline.ts',
    find: 'function hasAlternation(source: string, extended: boolean): boolean {',
    replace: 'function hasAlternation(source: string, extended: boolean): boolean {\n  return false',
  },
  {
    label: '方括号守卫',
    file: 'src/grepline.ts',
    find: `        if (source[cursor] === ']') return false
        for (; cursor < source.length && source[cursor] !== ']'; cursor++) {
          const inner = source[cursor]
          if (inner === '\\\\') return false
          if (inner === '[' && ':.='.includes(source[cursor + 1] ?? '')) return false
        }
        if (cursor === source.length) return false`,
    replace: "        for (; cursor < source.length && source[cursor] !== ']'; cursor++) {}",
  },
  {
    label: '重复算子保守窗口',
    file: 'src/grepline.ts',
    find: 'function countRepetitions(source: string, extended: boolean): number {',
    replace: 'function countRepetitions(source: string, extended: boolean): number {\n  return 0',
  },
  {
    label: '白名单判定',
    file: 'src/grepline.ts',
    find: '  const { sources, flags, fromFile } = parsed',
    replace: '  return true\n  const { sources, flags, fromFile } = parsed',
  },
];

if (mutations.length !== 7) throw new Error('变异表必须完整包含 7 项');

const packageRoot = fileURLToPath(new URL('../packages/dsh-result-clipper/', import.meta.url));
for (const { label, file, find } of mutations) {
  const source = readFileSync(join(packageRoot, file), 'utf8');
  if (source.split(find).length !== 2) throw new Error(`${label}：替换目标必须恰好出现一次`);
}

const temp = mkdtempSync(join(tmpdir(), 'dsh-mutation-guard-'));
const copy = join(temp, 'packages/dsh-result-clipper');

function runTests(name) {
  const reportPath = join(temp, `${name}.json`);
  const logPath = join(temp, `${name}.log`);
  const log = openSync(logPath, 'w');
  let result;
  try {
    result = spawnSync(process.execPath, [
      join(copy, 'node_modules/vitest/vitest.mjs'), 'run',
      '--reporter=json', `--outputFile=${reportPath}`,
    ], { cwd: copy, stdio: ['ignore', log, log] });
  } finally {
    closeSync(log);
  }
  if (result.error) throw result.error;
  if (result.signal) throw new Error(`vitest 被信号 ${result.signal} 中断`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  const failures = [];
  for (const suite of report.testResults) {
    const assertion = suite.assertionResults.find(test => test.status === 'failed');
    if (assertion) failures.push(`${relative(copy, suite.name)} > ${assertion.fullName}`);
  }
  if (result.status !== 0 && failures.length === 0) {
    console.error(readFileSync(logPath, 'utf8'));
    for (const suite of report.testResults) if (suite.message) console.error(suite.message);
    throw new Error('vitest 执行失败，但没有失败断言，不能算作捕获变异');
  }
  return { status: result.status, failures };
}

try {
  cpSync(fileURLToPath(new URL('../tsconfig.base.json', import.meta.url)), join(temp, 'tsconfig.base.json'));
  cpSync(packageRoot, copy, {
    recursive: true,
    filter: source => source !== join(packageRoot, 'node_modules'),
  });
  symlinkSync(join(packageRoot, 'node_modules'), join(copy, 'node_modules'), 'dir');

  // 基线不绿时，变异后的红不能证明守卫有效。
  console.log('[mutation-guard] 检查未变异基线');
  const baseline = runTests('baseline');
  if (baseline.status !== 0) throw new Error(`未变异基线失败：\n${baseline.failures.join('\n')}`);

  const survived = [];
  for (const [index, { label, file, find, replace }] of mutations.entries()) {
    const target = join(copy, file);
    const source = readFileSync(target, 'utf8');
    console.log(`[mutation-guard] ${index + 1}/${mutations.length} ${label}`);
    try {
      writeFileSync(target, source.replace(find, replace));
      const result = runTests(`mutation-${index + 1}`);
      if (result.status === 0) {
        survived.push(label);
        console.error(`[mutation-guard] 待修：${label} 变异后测试仍全绿`);
      } else {
        console.log(`[mutation-guard] 已捕获：${result.failures.join('\n')}`);
      }
    } finally {
      writeFileSync(target, source);
    }
  }
  if (survived.length > 0) throw new Error(`未捕获的变异：${survived.join('、')}`);
  console.log('[mutation-guard] 全部 7 项变异均被测试捕获');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
