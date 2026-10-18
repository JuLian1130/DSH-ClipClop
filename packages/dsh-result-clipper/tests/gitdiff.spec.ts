/**
 * 票 16 的 `git diff` 命令族 handler：只走 `compactDiff` 这个纯函数接缝，不断言内部实现。
 *
 * 夹具全部是真实 `git diff` 输出（git 2.39.5，临时库在 /tmp，不入仓库），逐字粘贴。带反斜杠的用
 * `String.raw`：`\344`（C-style 八进制）与 `\ No newline` 必须保持字面，否则 JS 会先吃掉一个字符。
 * 期望值是手算的字面量，不用实现自身推导。
 *
 * @module
 */

import { describe, expect, it } from 'vitest'
import { GIT_DIFF_DEFAULTS, compactDiff, type GitDiffParams } from '../src/gitdiff.ts'

/** 默认参数上改一两个值；判据 9「把值改掉即按其取值生效」靠这里构造。 */
const at = (over: Partial<GitDiffParams> = {}): GitDiffParams => ({ ...GIT_DIFF_DEFAULTS, ...over })

/** `git diff -- nonewline.txt`：两个侧都没尾换行，`\ No newline` 出现在 hunk 内与 hunk 外两种位置。 */
const NONE_NEWLINE = String.raw`diff --git a/nonewline.txt b/nonewline.txt
index d810ead..c6568ea 100644
--- a/nonewline.txt
+++ b/nonewline.txt
@@ -1 +1 @@
-old line
\ No newline at end of file
+new line
\ No newline at end of file
`

/** `git diff -U5 -- multi.txt`：四个 hunk，每个前导上下文 3 行、尾随 3 行，hunk 头带尾部符号上下文。 */
const MULTI = `diff --git a/multi.txt b/multi.txt
index 5dba4ca..fcf918f 100644
--- a/multi.txt
+++ b/multi.txt
@@ -1,6 +1,6 @@
 section 1 line A
 section 1 line B
-section 1 line C
+section 1 line C CHANGED
 section 1 line D
 section 1 line E
 section 2 line A
@@ -98,7 +98,7 @@ section 20 line B
 section 20 line C
 section 20 line D
 section 20 line E
-section 21 line A
+section 11 line A CHANGED
 section 21 line B
 section 21 line C
 section 21 line D
@@ -298,7 +298,7 @@ section 60 line B
 section 60 line C
 section 60 line D
 section 60 line E
-section 61 line A
+section 31 line A CHANGED
 section 61 line B
 section 61 line C
 section 61 line D
@@ -398,7 +398,7 @@ section 80 line B
 section 80 line C
 section 80 line D
 section 80 line E
-section 81 line A
+section 41 line B CHANGED
 section 81 line B
 section 81 line C
 section 81 line D
`

/** `git diff -U5 -- ctx.txt`：两个 hunk，每个变更行前有 5 行上下文（默认 git 只给 3 行）。 */
const WIDE_CONTEXT = `diff --git a/ctx.txt b/ctx.txt
index 9efd96c..a6e616d 100644
--- a/ctx.txt
+++ b/ctx.txt
@@ -7,11 +7,11 @@ L06
 L07
 L08
 L09
 L10
 L11
-L12
+L12 CHANGED
 L13
 L14
 L15
 L16
 L17
@@ -23,8 +23,8 @@ L22
 L23
 L24
 L25
 L26
 L27
-L28
+L28 CHANGED
 L29
 L30
`

/** `chmod +x script.sh`：没有 hunk，唯一的观察面是那两行模式。 */
const MODE_ONLY = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
`

/** `git mv old.txt renamed.txt` 后 `git diff -M HEAD`：无 hunk，靠 `rename from` / `rename to` 才看得出。 */
const RENAME_ONLY = `diff --git a/old.txt b/renamed.txt
similarity index 100%
rename from old.txt
rename to renamed.txt
`

/** `cp copysrc.txt copydst.txt` + `git add -N` 后 `git diff -C --find-copies-harder`。 */
const COPY_ONLY = `diff --git a/copysrc.txt b/copydst.txt
similarity index 100%
copy from copysrc.txt
copy to copydst.txt
`

/** 二进制文件改动：无 hunk，只有 `Binary files … differ`。 */
const BINARY_ONLY = `diff --git a/bin.dat b/bin.dat
index a2c7a65..1bc77a8 100644
Binary files a/bin.dat and b/bin.dat differ
`

/** 新建的空文件：无 hunk，连 `---` / `+++` 都没有，只剩 `new file mode` 这一行变化类型。 */
const NEW_EMPTY_FILE = `diff --git a/empty.txt b/empty.txt
new file mode 100644
index 0000000..e69de29
`

/** 删除文件：`deleted file mode` 加一个纯删 hunk。 */
const DELETED_FILE = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index d02fea3..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-gone one
-gone two
`

/** 同一文件既改权限又改正文：模式行与 hunk 明细都得在。 */
const MODE_AND_BODY = `diff --git a/mixed.sh b/mixed.sh
old mode 100644
new mode 100755
index 9af7b03..feac604
--- a/mixed.sh
+++ b/mixed.sh
@@ -1,2 +1,3 @@
 #!/bin/sh
 echo mixed
+mixed changed
`

/** `git diff -- 中文.txt`：Git 默认 `core.quotepath`，中文路径必然带引号与八进制转义。 */
const CHINESE_QUOTED = String.raw`diff --git "a/\344\270\255\346\226\207.txt" "b/\344\270\255\346\226\207.txt"
index e5c5c55..0c2aa38 100644
--- "a/\344\270\255\346\226\207.txt"
+++ "b/\344\270\255\346\226\207.txt"
@@ -1,2 +1,3 @@
 line one
 line two
+line three
`

/** 文件名叫 `中 文.txt`：引号路径里带空格，`---` / `+++` 行的收尾制表符是 git 真写出来的。 */
const CHINESE_SPACE_QUOTED = String.raw`diff --git "a/\344\270\255 \346\226\207.txt" "b/\344\270\255 \346\226\207.txt"
index de2162a..e706d25 100644
--- "a/\344\270\255 \346\226\207.txt"${'\t'}
+++ "b/\344\270\255 \346\226\207.txt"${'\t'}
@@ -1 +1,2 @@
 中 文内容
+中 文内容追加
`

/** 文件名叫 `with<TAB>tab.txt`：git 把制表符转义成 `\t` 两个字符。 */
const TAB_QUOTED = String.raw`diff --git "a/with\ttab.txt" "b/with\ttab.txt"
index d567e55..9e37f75 100644
--- "a/with\ttab.txt"
+++ "b/with\ttab.txt"
@@ -1 +1,2 @@
 tab content
+more tab
`

/** 文件名叫 `qu"ote.txt`：`\"` 转义。 */
const QUOTE_ESCAPED = String.raw`diff --git "a/qu\"ote.txt" "b/qu\"ote.txt"
index 04058f0..6d6c195 100644
--- "a/qu\"ote.txt"
+++ "b/qu\"ote.txt"
@@ -1 +1,2 @@
 quote content
+quote more
`

/** 文件名叫 `back\slash.txt`：`\\` 转义。 */
const BACKSLASH_ESCAPED = String.raw`diff --git "a/back\\slash.txt" "b/back\\slash.txt"
index 262430e..94cdf95 100644
--- "a/back\\slash.txt"
+++ "b/back\\slash.txt"
@@ -1 +1,2 @@
 backslash content
+backslash more
`

/** 文件名叫 `my file.txt`：不引号，靠 ` b/` 切分。 */
const SPACE_UNQUOTED = String.raw`diff --git a/my file.txt b/my file.txt
index 34eb89c..e217733 100644
--- a/my file.txt${'\t'}
+++ b/my file.txt${'\t'}
@@ -1 +1,2 @@
 space content
+more space
`

/** 文件名叫 `p b/q`：`diff --git` 头里出现三个可以切开的位置，切分有歧义。 */
const AMBIGUOUS_UNQUOTED = String.raw`diff --git a/p b/q b/p b/q
index 1d79c93..3fdd4c3 100644
--- a/p b/q${'\t'}
+++ b/p b/q${'\t'}
@@ -1 +1,2 @@
 q content
+q more
`

/** 从 ASCII 文件重命名到中文名：git 只给目标侧加引号，切分点在第一个引号处。 */
const MIXED_QUOTING = String.raw`diff --git a/oldasc.txt "b/\344\270\255\346\226\207\346\224\271\345\220\215.txt"
similarity index 100%
rename from oldasc.txt
rename to "\344\270\255\346\226\207\346\224\271\345\220\215.txt"
`

/** 真实头里抠掉第一个路径的收尾引号：引号不闭合。 */
const UNCLOSED_QUOTE = CHINESE_QUOTED.replace('.txt" "b/', '.txt "b/')

/** 真实头里的 `\344` 改成非八进制的 `\9`：转义非法。 */
const BAD_ESCAPE = CHINESE_QUOTED.replace('\\344', '\\9')

/** 真实头里的 `中` 换成一个孤立的 `\377` 字节：不是合法 UTF-8。 */
const BROKEN_UTF8 = CHINESE_QUOTED.replace('\\344\\270\\255', '\\377')

/** `git diff --stat`：压根不是 unified diff。 */
const STAT_OUTPUT = String.raw` bin.dat                        | Bin 12 -> 18 bytes
 empty.txt                      |   0
 mixed.sh                       |   1 +
 multi.txt                      |   8 ++++----
 my file.txt                    |   1 +
 nonewline.txt                  |   2 +-
 p b/q                          |   1 +
 script.sh                      |   0
 "with\ttab.txt"                |   1 +
 "\344\270\255\346\226\207.txt" |   1 +
 10 files changed, 10 insertions(+), 5 deletions(-)
`

/** `git diff --name-only`：同样不是 unified diff。 */
const NAME_ONLY_OUTPUT = String.raw`bin.dat
empty.txt
mixed.sh
multi.txt
my file.txt
nonewline.txt
p b/q
script.sh
"with\ttab.txt"
"\344\270\255\346\226\207.txt"
`

/** `git diff --word-diff`：hunk 正文行没有标记列（`line one`、`{+line three+}`）。 */
const WORD_DIFF = String.raw`diff --git "a/\344\270\255\346\226\207.txt" "b/\344\270\255\346\226\207.txt"
index e5c5c55..0c2aa38 100644
--- "a/\344\270\255\346\226\207.txt"
+++ "b/\344\270\255\346\226\207.txt"
@@ -1,2 +1,3 @@
line one
line two
{+line three+}
`

/** 真实输出被截断在 hunk 中间（hunk 声明 1 删 1 增，正文只到删行与 `\ No newline`）。 */
const TRUNCATED_AT_EOF = NONE_NEWLINE.slice(0, NONE_NEWLINE.indexOf('+new line'))

/** hunk 还开着就来了下一个文件头。 */
const HUNK_THEN_FILE_HEADER = TRUNCATED_AT_EOF + MULTI

/** hunk 还开着就来了下一个 `@@` 头（从真实输出里删掉前一个 hunk 的尾随上下文）。 */
const HUNK_THEN_HUNK_HEADER = MULTI.replace(
  ' section 1 line D\n section 1 line E\n section 2 line A\n@@ -98,7 +98,7 @@',
  '@@ -98,7 +98,7 @@',
)

/** 真实输出里插进一行无法识别的正文：hunk 之外。 */
const STRAY_LINE = CHINESE_QUOTED.replace('@@ -1,2 +1,3 @@', 'garbage line\n@@ -1,2 +1,3 @@')

/** 真实 hunk 头的行数写成非数字：解析不出 hunk 头。 */
const BAD_HUNK_HEADER = MULTI.replace('@@ -1,6 +1,6 @@', '@@ -1,x +1,6 @@')

/** `git diff -- ctx.txt multi.txt`：两个文件，ctx.txt 一处改（+1 -1）、multi.txt 相邻两行（+2 -2）。 */
const TWO_FILES = `diff --git a/ctx.txt b/ctx.txt
index a6e616d..83815b0 100644
--- a/ctx.txt
+++ b/ctx.txt
@@ -2,7 +2,7 @@ L01
 L02
 L03
 L04
-L05
+L05 SECOND
 L06
 L07
 L08
diff --git a/multi.txt b/multi.txt
index fcf918f..b7fdd65 100644
--- a/multi.txt
+++ b/multi.txt
@@ -1,5 +1,5 @@
-section 1 line A
-section 1 line B
+section 1 line A AGAIN
+section 1 line B AGAIN
 section 1 line C CHANGED
 section 1 line D
 section 1 line E
`

/** `git diff -- bulk.txt`：单文件单 hunk，60 删 60 增——明细超过默认封顶 100 行。 */
const BULK_CHANGED = `diff --git a/bulk.txt b/bulk.txt
index 606fc92..fca89e0 100644
--- a/bulk.txt
+++ b/bulk.txt
@@ -3,66 +3,66 @@ bulk 002 line
 bulk 003 line
 bulk 004 line
 bulk 005 line
-bulk 006 line
-bulk 007 line
-bulk 008 line
-bulk 009 line
-bulk 010 line
-bulk 011 line
-bulk 012 line
-bulk 013 line
-bulk 014 line
-bulk 015 line
-bulk 016 line
-bulk 017 line
-bulk 018 line
-bulk 019 line
-bulk 020 line
-bulk 021 line
-bulk 022 line
-bulk 023 line
-bulk 024 line
-bulk 025 line
-bulk 026 line
-bulk 027 line
-bulk 028 line
-bulk 029 line
-bulk 030 line
-bulk 031 line
-bulk 032 line
-bulk 033 line
-bulk 034 line
-bulk 035 line
-bulk 036 line
-bulk 037 line
-bulk 038 line
-bulk 039 line
-bulk 040 line
-bulk 041 line
-bulk 042 line
-bulk 043 line
-bulk 044 line
-bulk 045 line
-bulk 046 line
-bulk 047 line
-bulk 048 line
-bulk 049 line
-bulk 050 line
-bulk 051 line
-bulk 052 line
-bulk 053 line
-bulk 054 line
-bulk 055 line
-bulk 056 line
-bulk 057 line
-bulk 058 line
-bulk 059 line
-bulk 060 line
-bulk 061 line
-bulk 062 line
-bulk 063 line
-bulk 064 line
-bulk 065 line
+bulk 006 line CHANGED
+bulk 007 line CHANGED
+bulk 008 line CHANGED
+bulk 009 line CHANGED
+bulk 010 line CHANGED
+bulk 011 line CHANGED
+bulk 012 line CHANGED
+bulk 013 line CHANGED
+bulk 014 line CHANGED
+bulk 015 line CHANGED
+bulk 016 line CHANGED
+bulk 017 line CHANGED
+bulk 018 line CHANGED
+bulk 019 line CHANGED
+bulk 020 line CHANGED
+bulk 021 line CHANGED
+bulk 022 line CHANGED
+bulk 023 line CHANGED
+bulk 024 line CHANGED
+bulk 025 line CHANGED
+bulk 026 line CHANGED
+bulk 027 line CHANGED
+bulk 028 line CHANGED
+bulk 029 line CHANGED
+bulk 030 line CHANGED
+bulk 031 line CHANGED
+bulk 032 line CHANGED
+bulk 033 line CHANGED
+bulk 034 line CHANGED
+bulk 035 line CHANGED
+bulk 036 line CHANGED
+bulk 037 line CHANGED
+bulk 038 line CHANGED
+bulk 039 line CHANGED
+bulk 040 line CHANGED
+bulk 041 line CHANGED
+bulk 042 line CHANGED
+bulk 043 line CHANGED
+bulk 044 line CHANGED
+bulk 045 line CHANGED
+bulk 046 line CHANGED
+bulk 047 line CHANGED
+bulk 048 line CHANGED
+bulk 049 line CHANGED
+bulk 050 line CHANGED
+bulk 051 line CHANGED
+bulk 052 line CHANGED
+bulk 053 line CHANGED
+bulk 054 line CHANGED
+bulk 055 line CHANGED
+bulk 056 line CHANGED
+bulk 057 line CHANGED
+bulk 058 line CHANGED
+bulk 059 line CHANGED
+bulk 060 line CHANGED
+bulk 061 line CHANGED
+bulk 062 line CHANGED
+bulk 063 line CHANGED
+bulk 064 line CHANGED
+bulk 065 line CHANGED
 bulk 066 line
 bulk 067 line
 bulk 068 line
`

/** `git diff --cc`（合并冲突期）：`diff --cc` 头只有一个路径，`@@@` 头宽两个标记列。 */
const COMBINED_CC = `diff --cc f.txt
index 9c43a82,983f448..0000000
--- a/f.txt
+++ b/f.txt
@@@ -1,2 -1,2 +1,6 @@@
++<<<<<<< HEAD
 +right one
++=======
+ left one
++>>>>>>> left
  base two
`

/** `git diff --binary`：二进制改动没有 `Binary files … differ`，取而代之的是 base64 载荷。 */
const BINARY_PATCH = `diff --git a/bin.dat b/bin.dat
index a2c7a65da1c68f112d13dc8539e3629f64b9f167..1bc77a8d9fd7800028a36e2ff434938c2c4db84f 100644
GIT binary patch
literal 18
ZcmZQzWMWRr%u6h){Qr-WBR9V&6#y{122B6}

literal 12
TcmZQzWMWRr%u6h){QnOC5Zwfc

`

describe('compactDiff · 形态', () => {
  it('单文件单 hunk：保留完整 @@ 头与全部 +/- 明细、计数一致；`\\ No newline` 在 hunk 内与 hunk 外都跳过', () => {
    expect(compactDiff(NONE_NEWLINE, GIT_DIFF_DEFAULTS)).toBe(
      '\nnonewline.txt\n@@ -1 +1 @@\n-old line\n+new line\n  +1 -1',
    )
  })

  it('默认参数是票 14 实测的那一档（明细 100 / 整体 200 / 每 hunk 前导 3）', () => {
    expect(GIT_DIFF_DEFAULTS).toEqual({ maxHunkLines: 100, maxLines: 200, leadingContext: 3 })
  })

  it('多 hunk 大文件：一个变更行都不丢、@@ 头带尾部符号上下文、计数按文件累计', () => {
    expect(compactDiff(MULTI, GIT_DIFF_DEFAULTS)).toBe([
      '',
      'multi.txt',
      '@@ -1,6 +1,6 @@',
      ' section 1 line A',
      ' section 1 line B',
      '-section 1 line C',
      '+section 1 line C CHANGED',
      ' section 1 line D',
      ' section 1 line E',
      ' section 2 line A',
      '@@ -98,7 +98,7 @@ section 20 line B',
      ' section 20 line C',
      ' section 20 line D',
      ' section 20 line E',
      '-section 21 line A',
      '+section 11 line A CHANGED',
      ' section 21 line B',
      ' section 21 line C',
      ' section 21 line D',
      '@@ -298,7 +298,7 @@ section 60 line B',
      ' section 60 line C',
      ' section 60 line D',
      ' section 60 line E',
      '-section 61 line A',
      '+section 31 line A CHANGED',
      ' section 61 line B',
      ' section 61 line C',
      ' section 61 line D',
      '@@ -398,7 +398,7 @@ section 80 line B',
      ' section 80 line C',
      ' section 80 line D',
      ' section 80 line E',
      '-section 81 line A',
      '+section 41 line B CHANGED',
      ' section 81 line B',
      ' section 81 line C',
      ' section 81 line D',
      '  +4 -4',
    ].join('\n'))
  })

  it('每 hunk 前导上下文 ≤ leadingContext：留下离变更最近的那几行', () => {
    expect(compactDiff(WIDE_CONTEXT, GIT_DIFF_DEFAULTS)).toBe([
      '',
      'ctx.txt',
      '@@ -7,11 +7,11 @@ L06',
      ' L09',
      ' L10',
      ' L11',
      '-L12',
      '+L12 CHANGED',
      ' L13',
      ' L14',
      ' L15',
      ' L16',
      ' L17',
      '@@ -23,8 +23,8 @@ L22',
      ' L25',
      ' L26',
      ' L27',
      '-L28',
      '+L28 CHANGED',
      ' L29',
      ' L30',
      '  +2 -2',
    ].join('\n'))
  })
})

describe('compactDiff · 封顶（判据 8.2）', () => {
  it('每 hunk 明细封顶 maxHunkLines：超出部分丢弃、逐 hunk 记注记，文件累计仍与明细一致', () => {
    expect(compactDiff(MULTI, at({ maxHunkLines: 1 }))).toBe([
      '',
      'multi.txt',
      '@@ -1,6 +1,6 @@',
      ' section 1 line A',
      ' section 1 line B',
      '-section 1 line C',
      '  ... (1 addition truncated: 原文第 9 行；先读这段，不够再 grep)',
      '@@ -98,7 +98,7 @@ section 20 line B',
      ' section 20 line C',
      ' section 20 line D',
      ' section 20 line E',
      '-section 21 line A',
      '  ... (1 addition truncated: 原文第 18 行；先读这段，不够再 grep)',
      '@@ -298,7 +298,7 @@ section 60 line B',
      ' section 60 line C',
      ' section 60 line D',
      ' section 60 line E',
      '-section 61 line A',
      '  ... (1 addition truncated: 原文第 27 行；先读这段，不够再 grep)',
      '@@ -398,7 +398,7 @@ section 80 line B',
      ' section 80 line C',
      ' section 80 line D',
      ' section 80 line E',
      '-section 81 line A',
      '  ... (1 addition truncated: 原文第 36 行；先读这段，不够再 grep)',
      '  +4 -4',
    ].join('\n'))
  })

  it('封顶没丢计数：明细里留下的增行 + 注记里报出的增行 = 文件累计的 +N', () => {
    const out = compactDiff(MULTI, at({ maxHunkLines: 1 }))
    expect(out).toBeDefined()
    const lines = out!.split('\n')
    const shown = lines.filter((line) => line.startsWith('+')).length
    const noted = lines
      .filter((line) => line.includes('addition'))
      .reduce((sum, line) => sum + Number(/(\d+) addition/.exec(line)![1]), 0)
    expect(shown + noted).toBe(Number(/\+(\d+) -/.exec(out!)![1]))
  })

  it('整体行数上限 maxLines：超出即截断并留痕；前导上下文不计入这个上限', () => {
    // maxLines=12 同时把全 diff 前导上下文压到 floor(12/10)=1 行。断在这里只可能是「已写出的行 - 前导行」
    // 到了 12：若前导上下文也计数，`+L28 CHANGED` 之前就会被截掉。
    expect(compactDiff(WIDE_CONTEXT, at({ maxLines: 12 }))).toBe([
      '',
      'ctx.txt',
      '@@ -7,11 +7,11 @@ L06',
      ' L11',
      '-L12',
      '+L12 CHANGED',
      ' L13',
      ' L14',
      ' L15',
      ' L16',
      ' L17',
      '@@ -23,8 +23,8 @@ L22',
      '-L28',
      '+L28 CHANGED',
      '',
      '... (more changes truncated: 原文第 26–27 行；先读这段，不够再 grep)',
      '  +2 -2',
    ].join('\n'))
  })
})

describe('compactDiff · 无 hunk 的文件（判据 8.3）', () => {
  it('纯权限变更：留下的不是空壳，而是那两行模式', () => {
    expect(compactDiff(MODE_ONLY, GIT_DIFF_DEFAULTS)).toBe(
      '\nscript.sh\nold mode 100644\nnew mode 100755',
    )
  })

  it('纯重命名：`rename from` / `rename to` 逐字留下', () => {
    expect(compactDiff(RENAME_ONLY, GIT_DIFF_DEFAULTS)).toBe(
      '\nrenamed.txt\nsimilarity index 100%\nrename from old.txt\nrename to renamed.txt',
    )
  })

  it('纯复制：`copy from` / `copy to` 逐字留下', () => {
    expect(compactDiff(COPY_ONLY, GIT_DIFF_DEFAULTS)).toBe(
      '\ncopydst.txt\nsimilarity index 100%\ncopy from copysrc.txt\ncopy to copydst.txt',
    )
  })

  it('二进制变更：`Binary files … differ` 留下，`index` 行仍然是内部元信息', () => {
    expect(compactDiff(BINARY_ONLY, GIT_DIFF_DEFAULTS)).toBe(
      '\nbin.dat\nBinary files a/bin.dat and b/bin.dat differ',
    )
  })

  it('新建空文件：连 hunk 都没有，也留下 `new file mode` 而不是只剩文件名', () => {
    expect(compactDiff(NEW_EMPTY_FILE, GIT_DIFF_DEFAULTS)).toBe(
      '\nempty.txt\nnew file mode 100644',
    )
  })

  it('删除文件：`deleted file mode` 与纯删 hunk 都在，计数为 -2', () => {
    expect(compactDiff(DELETED_FILE, GIT_DIFF_DEFAULTS)).toBe(
      '\ngone.txt\ndeleted file mode 100644\n@@ -1,2 +0,0 @@\n-gone one\n-gone two\n  +0 -2',
    )
  })

  it('有 hunk 的文件同样适用：权限行与正文明细都得在', () => {
    expect(compactDiff(MODE_AND_BODY, GIT_DIFF_DEFAULTS)).toBe([
      '',
      'mixed.sh',
      'old mode 100644',
      'new mode 100755',
      '@@ -1,2 +1,3 @@',
      ' #!/bin/sh',
      ' echo mixed',
      '+mixed changed',
      '  +1 -0',
    ].join('\n'))
  })
})

describe('compactDiff · 引号路径（判据 8.5）', () => {
  const labelOf = (out: string | undefined): string => out!.split('\n')[1]!

  it('八进制 UTF-8 还原：呈现的文件名逐字等于真实路径 `中文.txt`', () => {
    const out = compactDiff(CHINESE_QUOTED, GIT_DIFF_DEFAULTS)
    expect(out).toBe('\n中文.txt\n@@ -1,2 +1,3 @@\n line one\n line two\n+line three\n  +1 -0')
    expect(labelOf(out)).toBe('中文.txt')
    expect(out).not.toContain('\\344')
  })

  it('引号里的空格与制表符还原成真实字符：`中 文.txt` 与 `with<TAB>tab.txt`', () => {
    const spaced = compactDiff(CHINESE_SPACE_QUOTED, GIT_DIFF_DEFAULTS)
    expect(labelOf(spaced)).toBe('中 文.txt')
    expect(spaced).toBe('\n中 文.txt\n@@ -1 +1,2 @@\n 中 文内容\n+中 文内容追加\n  +1 -0')

    const tabbed = compactDiff(TAB_QUOTED, GIT_DIFF_DEFAULTS)
    expect(labelOf(tabbed)).toBe('with\ttab.txt')
    // 只脱引号、不还原转义的实现会在这里留下 `\t` 两个字符。
    expect(tabbed).not.toContain('\\t')
  })

  it('`\\"` 与 `\\\\` 按 C 语义还原', () => {
    expect(labelOf(compactDiff(QUOTE_ESCAPED, GIT_DIFF_DEFAULTS))).toBe('qu"ote.txt')
    expect(labelOf(compactDiff(BACKSLASH_ESCAPED, GIT_DIFF_DEFAULTS))).toBe('back\\slash.txt')
  })

  it('不引号但含空格的路径：按 ` b/` 切分，文件名逐字等于 `my file.txt`', () => {
    const out = compactDiff(SPACE_UNQUOTED, GIT_DIFF_DEFAULTS)
    expect(labelOf(out)).toBe('my file.txt')
    expect(out).toBe('\nmy file.txt\n@@ -1 +1,2 @@\n space content\n+more space\n  +1 -0')
  })

  it('只给目标侧加引号的重命名：切分点由引号定，文件名逐字等于 `中文改名.txt`', () => {
    const out = compactDiff(MIXED_QUOTING, GIT_DIFF_DEFAULTS)
    expect(labelOf(out)).toBe('中文改名.txt')
    expect(out).toContain('\nsimilarity index 100%\nrename from oldasc.txt\n')
  })

  it('切分有歧义（文件名含 ` b/`）：保留完整原文件头，不把增减量归到别的文件名下', () => {
    const out = compactDiff(AMBIGUOUS_UNQUOTED, GIT_DIFF_DEFAULTS)
    expect(labelOf(out)).toBe('diff --git a/p b/q b/p b/q')
    expect(out).toContain('\n@@ -1 +1,2 @@\n q content\n+q more\n  +1 -0')
  })

  it('引号不闭合 / 转义非法 / 不是合法 UTF-8：一律保留完整原文件头', () => {
    for (const broken of [UNCLOSED_QUOTE, BAD_ESCAPE, BROKEN_UTF8]) {
      const out = compactDiff(broken, GIT_DIFF_DEFAULTS)
      expect(out).toBeDefined()
      expect(labelOf(out)).toBe(broken.split('\n')[0])
      expect(labelOf(out)).toContain('diff --git ')
    }
  })
})

describe('compactDiff · 守卫（判据 8.6）', () => {
  it('不是 unified diff：`--stat` / `--name-only` / 任意正文一律放弃', () => {
    expect(compactDiff(STAT_OUTPUT, GIT_DIFF_DEFAULTS)).toBeUndefined()
    expect(compactDiff(NAME_ONLY_OUTPUT, GIT_DIFF_DEFAULTS)).toBeUndefined()
    expect(compactDiff('', GIT_DIFF_DEFAULTS)).toBeUndefined()
    expect(compactDiff('hello world\n', GIT_DIFF_DEFAULTS)).toBeUndefined()
  })

  it('`--word-diff` 的无标记正文行（标记列非法）整次放弃', () => {
    expect(compactDiff(WORD_DIFF, GIT_DIFF_DEFAULTS)).toBeUndefined()
  })

  it('hunk 在 EOF 未耗尽：整次放弃', () => {
    // 真实输出被工具自己截断的样子：hunk 声明 1 删 1 增，正文只到删行。
    expect(compactDiff(TRUNCATED_AT_EOF, GIT_DIFF_DEFAULTS)).toBeUndefined()
  })

  it('hunk 未耗尽就遇到下一个文件头 / 下一个 hunk 头：整次放弃', () => {
    expect(compactDiff(HUNK_THEN_FILE_HEADER, GIT_DIFF_DEFAULTS)).toBeUndefined()
    expect(compactDiff(HUNK_THEN_HUNK_HEADER, GIT_DIFF_DEFAULTS)).toBeUndefined()
  })

  it('hunk 之外出现无法识别的行、或解析不出的 @@ 头：整次放弃', () => {
    expect(compactDiff(STRAY_LINE, GIT_DIFF_DEFAULTS)).toBeUndefined()
    expect(compactDiff(BAD_HUNK_HEADER, GIT_DIFF_DEFAULTS)).toBeUndefined()
  })

  it('内部异常也归 undefined，不抛给调用方', () => {
    expect(() => compactDiff(null as unknown as string, GIT_DIFF_DEFAULTS)).not.toThrow()
    expect(compactDiff(null as unknown as string, GIT_DIFF_DEFAULTS)).toBeUndefined()
  })
})

describe('compactDiff · 计数覆盖整份输入（判据 8.1 的「计数不假」）', () => {
  it('整体行数用尽后不再输出明细，但每个文件的 +N -M 仍是整份输入的真实数', () => {
    // 断点落在 ctx.txt 的 `-L05` 之后：它的 `+L05 SECOND` 没被显示，却必须计进 ctx.txt 的聚合量。
    expect(compactDiff(TWO_FILES, at({ maxLines: 3 }))).toBe([
      '',
      'ctx.txt',
      '@@ -2,7 +2,7 @@ L01',
      '-L05',
      '',
      '... (more changes truncated: 原文第 10–25 行；先读这段，不够再 grep)',
      '  +1 -1',
      '',
      'multi.txt',
      '  +2 -2',
    ].join('\n'))
  })

  it('单文件明细被默认封顶 100 行时，聚合量是整份文件的真实数（60 删 60 增）而不是明细行数', () => {
    const out = compactDiff(BULK_CHANGED, GIT_DIFF_DEFAULTS)
    expect(out).toBeDefined()
    const lines = out!.split('\n')
    // 手算：这个 hunk 是 60 删 + 60 增；明细封顶 100 行，所以显示 60 删 + 40 增，剩下 20 增只出现在注记里。
    expect(lines[lines.length - 1]).toBe('  +60 -60')
    expect(out).toContain('... (20 additions truncated: 原文第 109–128 行；先读这段，不够再 grep)')
    expect(lines.filter((line) => line.startsWith('-')).length).toBe(60)
    expect(lines.filter((line) => line.startsWith('+')).length).toBe(40)
  })
})

describe('compactDiff · 合并 diff（--cc）', () => {
  it('`@@@` 头按两个标记列解析：合并冲突的每一行都留下，聚合量按 `+` 列统计', () => {
    expect(compactDiff(COMBINED_CC, GIT_DIFF_DEFAULTS)).toBe([
      '',
      'f.txt',
      '@@@ -1,2 -1,2 +1,6 @@@',
      '++<<<<<<< HEAD',
      ' +right one',
      '++=======',
      '+ left one',
      '++>>>>>>> left',
      '  base two',
      '  +5 -0',
    ].join('\n'))
  })
})

describe('compactDiff · 二进制补丁（判据 8.3 / 8.4）', () => {
  it('`--binary` 的 base64 载荷不在识别集合里：整次放弃，不把它压成一个文件名', () => {
    expect(compactDiff(BINARY_PATCH, GIT_DIFF_DEFAULTS)).toBeUndefined()
  })
})
