/* Comfy SDK transport test: uploads an image, copies it through a minimal
   graph (LoadImage → SaveImage), downloads the result. No GPU needed.
   COMFY_BASE_URL=http://127.0.0.1:8189 node scripts/essai-sdk.mjs image.png sortie.png */
import { Comfy } from '@comfyorg/sdk'
const [src, dst] = process.argv.slice(2)
const client = new Comfy({ clientInfo: 'creatoros-studio' })
const wf = client.workflows.fromJson({
  '1': { class_type: 'LoadImage', inputs: { image: '' } },
  '2': { class_type: 'SaveImage', inputs: { filename_prefix: 'essai_sdk', images: ['1', 0] } },
})
wf.setInput('1', 'image', client.assets.fromFile(src))
const t0 = Date.now()
const job = await client.submit(wf)
console.log('soumis', job.id, job.status)
await job.wait()
console.log('fini', job.status, `${Date.now() - t0} ms`, job.outputs.map(o => [o.nodeId, o.type, o.name, o.sizeBytes]))
await job.getOutputs('2')[0].toFile(dst)
console.log('écrit', dst)
