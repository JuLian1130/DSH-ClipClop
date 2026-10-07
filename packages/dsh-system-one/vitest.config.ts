import ts from 'typescript'
import { defineConfig } from 'vitest/config'

const decoratorSyntax = /^\s*@[A-Za-z_$][\w$]*/m

/**
 * 在 Vite 默认解析器看到源文件之前，先把标准 TypeScript 装饰器降级。
 *
 * `src/service.ts` 用 `@Remote` 标记要投影给浏览器的只读方法，而 Vite 的解析器读不了标准装饰器：
 * 不降级的话，导入该模块会以 `SyntaxError: Invalid or unexpected token` 在测试期炸掉（构建产物由
 * `tsc` 直出，不受影响）。
 *
 * 这份实现是宿主 `vitest.shared.ts` 里 `standardDecoratorPlugin()` 的拷贝，不是引用（宿主那份不在
 * 本仓的依赖里）。**有意的差异**：宿主还会给编译合成的 `__esDecorate(` 行加 v8 忽略注释——那是给它
 * 自己的覆盖率统计用的，而本仓没有任何覆盖率配置，照抄只会多一段不生效的死代码。哪天本包开了
 * 覆盖率，就把那段补回来。两份同名函数对比即可看出漂移，漂移了以宿主为准。
 */
function standardDecorators() {
  return {
    name: 'dsh-system-one-standard-decorators',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      const file = id.split('?', 1)[0]!
      if (!/\.[cm]?tsx?$/.test(file) || !decoratorSyntax.test(code)) return
      const result = ts.transpileModule(code, {
        fileName: file,
        compilerOptions: {
          target: ts.ScriptTarget.ES2024,
          module: ts.ModuleKind.ESNext,
          sourceMap: true,
        },
      })
      return {
        code: result.outputText.replace(/\n?\/\/# sourceMappingURL=.*$/u, '\n'),
        map: result.sourceMapText,
      }
    },
  }
}

export default defineConfig({ plugins: [standardDecorators()] })
