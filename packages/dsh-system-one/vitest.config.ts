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
 * 这份实现对照宿主 `vitest.shared.ts` 的 `standardDecoratorPlugin()`（本包函数另起了名字，不叫这个），
 * 是拷贝而不是引用——宿主那份不在本仓的依赖里。相对宿主**有意少两处**：编译合成的 `__esDecorate(`
 * 行上的 v8 忽略注释（本仓没有任何覆盖率配置，照抄只会多一段不生效的死代码）、以及 `.tsx` 的 jsx
 * 选项（本包没有 tsx 源）。哪天本包开了覆盖率或加了 tsx 源，就把对应那处补回来。
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
