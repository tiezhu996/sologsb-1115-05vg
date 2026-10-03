const path = require('path')
const fs = require('fs')
const esbuild = require('esbuild')
function resolveWithExtensions(basePath) {
  for (const ext of ['.ts', '.tsx', '.js', '.json']) if (fs.existsSync(basePath + ext)) return basePath + ext
  return basePath
}
esbuild.build({
  entryPoints: [path.resolve(__dirname, 'upgrade.test.ts')],
  bundle: true, platform: 'node', format: 'cjs',
  outfile: path.resolve(__dirname, '.upgrade.test.cjs'),
  resolveExtensions: ['.ts', '.tsx', '.js', '.json'],
  plugins: [{ name: 'alias', setup(build) {
    build.onResolve({ filter: /^@\// }, (args) => ({
      path: resolveWithExtensions(path.resolve(__dirname, '..', 'src', args.path.slice(2)))
    }))
  } }],
  logLevel: 'silent'
}).catch((e) => { console.error(e); process.exit(1) })
