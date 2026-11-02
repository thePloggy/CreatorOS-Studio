/* Après `vite build` : écrit un .br et un .gz à côté de chaque js/css/html/svg
   de dist/. @fastify/static (preCompressed) les sert selon Accept-Encoding —
   le bundle principal passe de 1,2 Mo à ~0,16 Mo sur le fil. */
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
