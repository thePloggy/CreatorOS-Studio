/* Regression tests for LoRA installation (node --test, no dependency).
   Everything runs in a temporary data folder: the environment is set BEFORE
   the server modules are imported, since config.js reads it once. */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'

const RACINE = fs.mkdtempSync(path.join(os.tmpdir(), 'creatoros-loras-'))
process.env.CREATOROS_DATA = path.join(RACINE, 'data')
process.env.CREATOROS_LORAS = path.join(RACINE, 'loras')
process.env.CREATOROS_PERSONA_FILE = path.join(RACINE, 'persona.json')
process.env.COMFY_DIR = path.join(RACINE, 'comfy')
process.env.CREATOROS_AI_TOOLKIT = path.join(RACINE, 'ai-toolkit')
delete process.env.CREATOROS_LORA_MODE
delete process.env.CREATOROS_LORA_GROUP

const { CONFIG } = await import('./config.js')
const L = await import('./installationLora.js')
const { erreurExecution } = await import('./erreurs.js')

after(() => fs.rmSync(RACINE, { recursive: true, force: true }))
before(() => fs.mkdirSync(CONFIG.lorasDir, { recursive: true }))

/* ---------- helpers ---------- */

const TAILLES = { F16: 2, BF16: 2, F32: 4 }
/** A real safetensors file in memory: header, then contiguous tensor data. */
function safetensors(tenseurs = { 'diffusion_model.double_blocks.0.lora_A': { dtype: 'F16', shape: [4, 8] } }, meta = null, { bourrage = 0 } = {}) {
  const tete = meta ? { __metadata__: meta } : {}
  let pos = 0
  for (const [k, t] of Object.entries(tenseurs)) {
    const n = t.shape.reduce((a, d) => a * d, 1) * TAILLES[t.dtype]
    tete[k] = { dtype: t.dtype, shape: t.shape, data_offsets: t.data_offsets ?? [pos, pos + n] }
    pos += n
  }
  const json = Buffer.from(JSON.stringify(tete))
  const len = Buffer.alloc(8); len.writeBigUInt64LE(BigInt(json.length))
  return Buffer.concat([len, json, crypto.randomBytes(pos + bourrage)])
}
const sha = f => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const mode = f => (fs.statSync(f).mode & 0o777).toString(8).padStart(4, '0')
const source = (nom, contenu, m = 0o600) => { const f = path.join(RACINE, nom); fs.writeFileSync(f, contenu, { mode: m }); fs.chmodSync(f, m); return f }
const restes = () => fs.readdirSync(CONFIG.lorasDir).filter(f => f.includes('.part-'))

/* ---------- installation ---------- */

test('restrictive source (0600): the installed copy gets the configured mode and the same bytes', () => {
  const src = source('a.safetensors', safetensors())
  assert.equal(mode(src), '0600')
  const r = L.installerLora(src, 'perso_klein_a.safetensors')
  assert.equal(mode(r.chemin), '0644')
  assert.equal(sha(r.chemin), sha(src))
  assert.equal(r.tenseurs, 1)
  assert.equal(r.mode, '0644')
  assert.deepEqual(restes(), [])
})

test('restrictive umask (077): a streamed upload still ends with an explicit, readable mode', async () => {
  const ancien = process.umask(0o077)
  try {
    const cible = path.join(CONFIG.lorasDir, 'upload.safetensors')
    const tmp = L.cheminTemporaire(cible)
    await new Promise((ok, ko) => { const out = fs.createWriteStream(tmp); out.on('error', ko); out.on('finish', ok); out.end(safetensors()) })
    assert.equal(mode(tmp), '0600')
    const r = L.finaliserLora(tmp, 'upload.safetensors')
    assert.equal(mode(r.chemin), '0644')
    assert.ok(!fs.existsSync(tmp))
  } finally { process.umask(ancien) }
})

test('CREATOROS_LORA_MODE is honoured; an unreadable value falls back to 0644', () => {
  const src = source('b.safetensors', safetensors())
  CONFIG.lorasMode = '0640'
  try { assert.equal(mode(L.installerLora(src, 'b640.safetensors').chemin), '0640') } finally { CONFIG.lorasMode = '' }
  CONFIG.lorasMode = 'readable-please'
  try { assert.equal(L.modeLora(), L.MODE_LORA_DEFAUT); assert.equal(mode(L.installerLora(src, 'bdef.safetensors').chemin), '0644') } finally { CONFIG.lorasMode = '' }
})

test('CREATOROS_LORA_GROUP: numeric gid applied, unknown name ignored', () => {
  const src = source('g.safetensors', safetensors())
  const gid = fs.statSync(src).gid
  CONFIG.lorasGroup = String(gid)
  try { assert.equal(fs.statSync(L.installerLora(src, 'g1.safetensors').chemin).gid, gid) } finally { CONFIG.lorasGroup = '' }
  CONFIG.lorasGroup = 'no-such-group-creatoros-test'
  try { assert.equal(L.groupeLora(), null); L.installerLora(src, 'g2.safetensors') } finally { CONFIG.lorasGroup = '' }
})

test('no silent overwrite: an existing file is refused (409) unless remplacer', () => {
  const src = source('c.safetensors', safetensors())
  L.installerLora(src, 'c.safetensors')
  assert.throws(() => L.installerLora(src, 'c.safetensors'), e => e.statusCode === 409)
  assert.deepEqual(restes(), [])
  L.installerLora(source('c2.safetensors', safetensors()), 'c.safetensors', { remplacer: true })
})

test('invalid names are refused before anything is written', () => {
  const src = source('n.safetensors', safetensors())
  for (const nom of ['../x.safetensors', 'sub/x.safetensors', 'x.ckpt', '']) assert.throws(() => L.installerLora(src, nom))
  assert.deepEqual(restes(), [])
})

/* ---------- structural validation ---------- */

test('validation accepts a well-formed file and reports its tensors', () => {
  const f = source('ok.safetensors', safetensors({ a: { dtype: 'F16', shape: [2, 3] }, b: { dtype: 'F32', shape: [5] } }, { ss_base_model_version: 'flux2' }))
  const v = L.validerSafetensors(f)
  assert.equal(v.tenseurs, 2)
  assert.equal(v.tete.__metadata__.ss_base_model_version, 'flux2')
})

test('validation rejects a truncated header, a bad JSON header, a range past end-of-file, a hole, a shape mismatch', () => {
  const bon = safetensors({ a: { dtype: 'F16', shape: [2, 3] } })
  const cas = {
    'trop court': bon.subarray(0, 10),
    'en-tête tronqué': bon.subarray(0, 8 + 5),
    'JSON illisible': (() => { const b = Buffer.from(bon); b.write('{"a":[[[', 8); return b })(),
    'au-delà de la fin': bon.subarray(0, bon.length - 2),
    'plage non contiguë': safetensors({ a: { dtype: 'F16', shape: [2, 3], data_offsets: [2, 14] } }, null, { bourrage: 2 }),
    'données en trop': safetensors({ a: { dtype: 'F16', shape: [2, 3] } }, null, { bourrage: 7 }),
    'shape fausse': safetensors({ a: { dtype: 'F16', shape: [2, 3], data_offsets: [0, 10] } }, null, { bourrage: -2 }),
    'longueur nulle': Buffer.concat([Buffer.alloc(8), Buffer.alloc(16)]),
    'pas un objet': (() => { const j = Buffer.from('[1,2,3]          '); const l = Buffer.alloc(8); l.writeBigUInt64LE(BigInt(j.length)); return Buffer.concat([l, j, Buffer.alloc(4)]) })(),
  }
  for (const [nom, contenu] of Object.entries(cas)) {
    const f = source(`ko-${nom.replace(/\W+/g, '_')}.safetensors`, contenu)
    assert.throws(() => L.validerSafetensors(f), `${nom} should be rejected`)
    assert.throws(() => L.installerLora(f, `ko-${nom.replace(/\W+/g, '_')}.safetensors`), `${nom} should not install`)
  }
  assert.deepEqual(restes(), [])
})

/* ---------- transactional ---------- */

test('a failing extra check installs nothing, leaves no temporary file, and names the destination', () => {
  const src = source('t.safetensors', safetensors())
  assert.throws(() => L.installerLora(src, 't.safetensors', { verifier: () => { throw new Error('architecture « inconnue » au lieu de « flux2 »') } }),
    e => /t\.safetensors/.test(e.message) && /architecture/.test(e.message))
  assert.ok(!fs.existsSync(path.join(CONFIG.lorasDir, 't.safetensors')))
  assert.deepEqual(restes(), [])
})

test('atomic replacement: the previous working LoRA survives a failed replacement', () => {
  const bon = source('r1.safetensors', safetensors())
  const r = L.installerLora(bon, 'r.safetensors')
  const avant = sha(r.chemin)
  const mauvais = source('r2.safetensors', safetensors().subarray(0, 20))
  assert.throws(() => L.installerLora(mauvais, 'r.safetensors', { remplacer: true }))
  assert.equal(sha(r.chemin), avant)
  assert.deepEqual(restes(), [])
})

test('the extra check sees the validated file and its header', () => {
  const src = source('v.safetensors', safetensors(undefined, { ss_output_name: 'lemon' }))
  let vu = null
  L.installerLora(src, 'v.safetensors', { verifier: (tmp, v) => { vu = { tmp, meta: v.tete.__metadata__ } } })
  assert.ok(vu.tmp.includes('.part-'))
  assert.equal(vu.meta.ss_output_name, 'lemon')
})

/* ---------- readability for the ComfyUI process (pure, no root needed) ---------- */

test('lisibleParDossier: owner-only file of another user is unreadable; 0644, same user, shared group or root are fine', () => {
  const f = (m, uid = 1000, gid = 1000) => ({ mode: m, uid, gid })
  const d = (uid = 2000, gid = 2000) => ({ uid, gid })
  assert.equal(L.lisibleParDossier(f(0o100600), d()).ok, false)
  assert.match(L.lisibleParDossier(f(0o100600), d()).raison, /mode 0600.*uid 1000.*uid 2000/)
  assert.equal(L.lisibleParDossier(f(0o100644), d()).ok, true)
  assert.equal(L.lisibleParDossier(f(0o100600), d(1000)).ok, true)
  assert.equal(L.lisibleParDossier(f(0o100640, 1000, 2000), d(2000, 2000)).ok, true)
  assert.equal(L.lisibleParDossier(f(0o100640, 1000, 1000), d(2000, 2000)).ok, false)
  assert.equal(L.lisibleParDossier(f(0o100600), d(0, 0)).ok, true)
})

test('an owner-only file whose folder belongs to another user is refused at installation', () => {
  const src = source('x.safetensors', safetensors())
  const statSync = fs.statSync
  fs.statSync = (p, ...a) => { const st = statSync(p, ...a); if (path.resolve(p) === path.resolve(CONFIG.lorasDir)) return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid: st.uid + 1, gid: st.gid + 1 }); return st }
  CONFIG.lorasMode = '0600'
  try {
    assert.throws(() => L.installerLora(src, 'x.safetensors'), /ComfyUI ne peut pas le lire.*CREATOROS_LORA_MODE/)
    assert.ok(!fs.existsSync(path.join(CONFIG.lorasDir, 'x.safetensors')))
  } finally { fs.statSync = statSync; CONFIG.lorasMode = '' }
  assert.deepEqual(restes(), [])
})

/* ---------- state, diagnostic input and repair ---------- */

test('etatLora / etatLorasPersonas describe missing, invalid and healthy character LoRAs', () => {
  L.installerLora(source('s.safetensors', safetensors()), 'sain.safetensors')
  fs.writeFileSync(path.join(CONFIG.lorasDir, 'casse.safetensors'), safetensors().subarray(0, 12))
  const liste = [{ id: 'ava', name: 'Ava', lorasKlein: [{ name: 'sain.safetensors' }, { name: 'absent.safetensors' }], loras: [{ name: 'casse.safetensors' }] },
    { id: 'bo', name: 'Bo', lorasKlein: [{ name: 'sain.safetensors' }], videoLoras: [{ name: '../evil.safetensors' }] }]
  const etats = Object.fromEntries(L.etatLorasPersonas(liste).map(e => [e.nom, e]))
  assert.deepEqual(Object.keys(etats).sort(), ['absent.safetensors', 'casse.safetensors', 'sain.safetensors'])
  assert.equal(etats['sain.safetensors'].valide, true)
  assert.equal(etats['sain.safetensors'].lisible, true)
  assert.equal(etats['sain.safetensors'].mode, '0644')
  assert.deepEqual(etats['sain.safetensors'].personnages, ['Ava', 'Bo'])
  assert.equal(etats['absent.safetensors'].existe, false)
  assert.equal(etats['absent.safetensors'].raison, 'fichier absent')
  assert.equal(etats['casse.safetensors'].valide, false)
  assert.match(etats['casse.safetensors'].erreur, /tronqué|court/)
})

test('repair normalizes the selected character LoRAs only, and reports what it cannot fix', () => {
  const r = L.installerLora(source('p.safetensors', safetensors()), 'perso.safetensors')
  fs.chmodSync(r.chemin, 0o600)
  const autre = path.join(CONFIG.lorasDir, 'tiers.safetensors')
  fs.writeFileSync(autre, safetensors()); fs.chmodSync(autre, 0o600)
  const liste = [{ id: 'ava', name: 'Ava', lorasKlein: [{ name: 'perso.safetensors' }, { name: 'absent.safetensors' }] }]
  const res = L.reparerLorasPersonas(liste, { noms: ['perso.safetensors'] })
  assert.deepEqual(res.repares, [{ nom: 'perso.safetensors', mode: '0644' }])
  assert.equal(res.restants.length, 1)
  assert.equal(res.restants[0].nom, 'absent.safetensors')
  assert.equal(mode(r.chemin), '0644')
  assert.equal(mode(autre), '0600', 'a third-party LoRA is never touched')
})

/* ---------- plain-language error ---------- */

test('a FileNotFoundError on a LoRA that exists is explained as a permission problem, not a missing model', () => {
  const r = L.installerLora(source('e.safetensors', safetensors()), 'lemon_klein.safetensors')
  const msg = erreurExecution({ messages: [['execution_error', { node_id: '7', node_type: 'LoraLoaderModelOnly', exception_type: 'FileNotFoundError', exception_message: `No such file or directory: ${r.chemin}` }]] })
  assert.match(msg, /ne peut pas la lire/)
  assert.match(msg, /droits/)
  assert.match(msg, /mode 0644/)
  const absent = erreurExecution({ messages: [['execution_error', { node_id: '7', node_type: 'LoraLoaderModelOnly', exception_type: 'FileNotFoundError', exception_message: `No such file or directory: ${path.join(CONFIG.lorasDir, 'nope.safetensors')}` }]] })
  assert.match(absent, /introuvable/)
  assert.doesNotMatch(absent, /droits/)
})

/* ---------- ai-toolkit result ---------- */

test('training: an ai-toolkit run that exits 0 with a bogus .safetensors is rejected', { skip: spawnSync('python3', ['--version']).status !== 0 && 'python3 not available' }, async () => {
  const kit = process.env.CREATOROS_AI_TOOLKIT
  fs.mkdirSync(kit, { recursive: true })
  // a fake run.py: writes "a LoRA" (garbage) where the real one would, exits 0
  fs.writeFileSync(path.join(kit, 'run.py'), `import os, sys, re
cfg = open(sys.argv[1]).read()
out = re.search(r'training_folder: "([^"]+)"', cfg).group(1)
name = re.search(r'name: "([^"]+)"', cfg).group(1)
os.makedirs(os.path.join(out, name), exist_ok=True)
open(os.path.join(out, name, name + '.safetensors'), 'wb').write(b'not a safetensors file at all')
`)
  const E = await import('./entrainement.js')
  const img = path.join(RACINE, 'img.png'); fs.writeFileSync(img, 'png')
  const prep = E.preparerEntrainement({ id: 'train-test', images: [img], declencheur: 'lemon', pas: 10, moteur: 'klein' })
  await assert.rejects(E.entrainer({ ...prep, id: 'train-test', pas: 10 }, () => {}), /LoRA produite illisible/)
})
