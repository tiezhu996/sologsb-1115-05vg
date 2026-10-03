// 仅用于本地验证：把 TS 测试按 vite 的 @/ 别名打包后在 Node 中运行
const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')

function resolveWithExtensions(basePath) {
  const exts = ['.ts', '.tsx', '.js', '.json']
  for (const ext of exts) {
    if (fs.existsSync(basePath + ext)) return basePath + ext
  }
  return basePath
}

const aliasPlugin = {
  name: 'alias',
  setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveWithExtensions(path.resolve(__dirname, '..', 'src', args.path.slice(2)))
    }))
  }
}

esbuild
  .build({
    entryPoints: [path.resolve(__dirname, 'loan.test.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: path.resolve(__dirname, '.loan.test.cjs'),
    plugins: [aliasPlugin],
    resolveExtensions: ['.ts', '.tsx', '.js', '.cjs', '.json'],
    logLevel: 'silent'
  })
  .catch((error) => {
    console.error(error)
    process.exit(1)
  })
