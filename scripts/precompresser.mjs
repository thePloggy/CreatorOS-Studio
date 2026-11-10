/* Post `vite build`: writes a .br and a .gz next to each js/css/html/svg/json
   file in dist/. @fastify/static (preCompressed) serves them by Accept-Encoding. */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const racine = path.resolve(import.meta.dirname, '..', 'dist')
const parcourir = d => fs.readdirSync(d, { withFileTypes: true })
  .flatMap(e => e.isDirectory() ? parcourir(path.join(d, e.name)) : [path.join(d, e.name)])
for (const f of parcourir(racine).filter(f => /\.(js|css|html|svg|json)$/.test(f))) {
  const brut = fs.readFileSync(f)
  if (brut.length < 1024) continue
  fs.writeFileSync(f + '.br', zlib.brotliCompressSync(brut, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }))
  fs.writeFileSync(f + '.gz', zlib.gzipSync(brut, { level: 9 }))
}
