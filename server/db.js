/* ============================================================
   Persistance SQLite — jobs, assets, provenance.
   node:sqlite (intégré à Node 22) : aucune dépendance native à
   compiler, donc rien à installer hors npm.
   Trois tables, conformes au modèle de données CreatorOS :
     jobs       : le contrat d'exécution + son issue
     assets     : les médias produits, servis depuis /media
     provenance : la lignée COMPLÈTE d'un asset (recette rejouable)
   ============================================================ */
import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { CONFIG } from './config.js'

fs.mkdirSync(path.dirname(CONFIG.dbFile), { recursive: true })
fs.mkdirSync(CONFIG.mediaDir, { recursive: true })

export const db = new DatabaseSync(CONFIG.dbFile)

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS jobs (
  id                TEXT PRIMARY KEY,
  created_at        INTEGER NOT NULL,
  started_at        INTEGER,
  finished_at       INTEGER,
  duration_ms       INTEGER,
  status            TEXT NOT NULL,
  persona_id        TEXT,
  register          TEXT,
  mode              TEXT,
  purpose           TEXT,
  recipe_id         TEXT,
  workflow_file     TEXT,
  comfy_prompt_id   TEXT,
  seed              INTEGER,
  user_prompt       TEXT,
  user_directives   TEXT,
  resolved_text     TEXT,
  composed_positive TEXT,
  composed_negative TEXT,
  selections        TEXT,
  error             TEXT
);

CREATE TABLE IF NOT EXISTS assets (
  id            TEXT PRIMARY KEY,
  job_id        TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL,
  media_type    TEXT NOT NULL,
  uri           TEXT NOT NULL,
  filename      TEXT NOT NULL,
  bytes         INTEGER,
  width         INTEGER,
  height        INTEGER,
  aspect        TEXT,
  register      TEXT,
  review_status TEXT NOT NULL DEFAULT 'pending',
  export_ready  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS provenance (
  asset_id          TEXT PRIMARY KEY REFERENCES assets(id) ON DELETE CASCADE,
  job_id            TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  recipe_id         TEXT,
  workflow_file     TEXT,
  comfy_prompt_id   TEXT,
  seed              INTEGER,
  composed_positive TEXT,
  composed_negative TEXT,
  user_prompt       TEXT,
  user_directives   TEXT,
  resolved_text     TEXT,
  identity_preamble TEXT,
  register_clause   TEXT,
  extra_loras       TEXT,
  source_image      TEXT,
  selections        TEXT,
  injections        TEXT,
  workflow_json     TEXT
);

CREATE INDEX IF NOT EXISTS idx_jobs_created  ON jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_job ON assets(job_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_persona ON jobs(persona_id, created_at DESC);
`)

db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS folder_assets (
  folder_id TEXT NOT NULL,
  asset_id TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (folder_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_folder_assets_asset ON folder_assets(asset_id);
`)

/* Migration de `folder_assets` créée sans clé étrangère : supprimer un média
   y laisserait sa ligne d'appartenance, et le compteur du dossier annoncerait
   des médias qui n'existent plus. On la reconstruit avec la même cascade que `provenance` ; la
   copie ne reprend que les liens dont le média ET le dossier existent, ce qui
   purge les orphelins au passage. Idempotent : une fois la clé posée, le test
   est faux et le bloc ne refait rien. */
if (!db.prepare('PRAGMA foreign_key_list(folder_assets)').all().length) {
  db.exec('PRAGMA foreign_keys = OFF')
  db.exec('BEGIN')
  try {
    db.exec(`
      CREATE TABLE folder_assets_neuf (
        folder_id TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
        asset_id  TEXT NOT NULL REFERENCES assets(id)  ON DELETE CASCADE,
        added_at  INTEGER NOT NULL,
        PRIMARY KEY (folder_id, asset_id)
      );
      INSERT INTO folder_assets_neuf (folder_id, asset_id, added_at)
        SELECT fa.folder_id, fa.asset_id, fa.added_at
        FROM folder_assets fa
        JOIN assets  a ON a.id = fa.asset_id
        JOIN folders f ON f.id = fa.folder_id;
      DROP TABLE folder_assets;
      ALTER TABLE folder_assets_neuf RENAME TO folder_assets;
      CREATE INDEX IF NOT EXISTS idx_folder_assets_asset ON folder_assets(asset_id);
    `)
    db.exec('COMMIT')
    console.log('[db] folder_assets reconstruite avec cascade — liens orphelins purgés')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  db.exec('PRAGMA foreign_keys = ON')
}

/* Bases antérieures à l'élargissement de la provenance : le prompt BRUT
   n'y était pas stocké, donc « Cloner » ne pouvait pas repeupler la colonne 3.
   ALTER idempotent — SQLite n'a pas d'IF NOT EXISTS sur ADD COLUMN. */
{
  const cols = new Set(db.prepare(`PRAGMA table_info(provenance)`).all().map(c => c.name))
  for (const c of ['user_prompt', 'user_directives', 'resolved_text', 'identity_preamble', 'register_clause', 'extra_loras', 'source_image'])
    if (!cols.has(c)) db.exec(`ALTER TABLE provenance ADD COLUMN ${c} TEXT`)
}

/* ---------- jobs ---------- */

/* La ligne de file en mémoire est plus riche que les colonnes (op, image
   source, moteur vidéo, LoRA…) : pour RECONSTRUIRE la file au redémarrage,
   on la garde entière, en JSON. Les colonnes restent la vue requêtable. */
try { db.exec('ALTER TABLE jobs ADD COLUMN payload TEXT') } catch { /* déjà là */ }
/* Clé d'idempotence d'envoi (mobile) : le client la génère AVANT le premier
   POST et la réutilise sur toute reprise de transport. L'index unique fait
   foi — deux envois de la même clé ne peuvent pas créer deux jobs, quelle que
   soit la course. Nullable : le desktop et les jobs internes n'en posent pas,
   et SQLite autorise autant de NULL qu'on veut dans un index unique. */
try { db.exec('ALTER TABLE jobs ADD COLUMN request_id TEXT') } catch { /* déjà là */ }
try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS jobs_request_id ON jobs(request_id)') } catch { /* déjà là */ }
/* Fonction de l'asset (op generate/swap, moteur vidéo ou 'motion') : sert à
   filtrer les galeries par catégorie. Rétro-remplie depuis le
   payload du job pour que la bibliothèque existante soit filtrable aussi. */
{
  const acols = new Set(db.prepare('PRAGMA table_info(assets)').all().map(c => c.name))
  if (!acols.has('op')) db.exec('ALTER TABLE assets ADD COLUMN op TEXT')
  if (!acols.has('video_engine')) db.exec('ALTER TABLE assets ADD COLUMN video_engine TEXT')
  /* Caption gravée des reels : le texte à l'écran, modifiable par
     l'opérateur ; `caption_options` garde les autres propositions du
     rédacteur, pour en choisir une sans relancer. */
  if (!acols.has('caption')) db.exec('ALTER TABLE assets ADD COLUMN caption TEXT')
  if (!acols.has('caption_options')) db.exec('ALTER TABLE assets ADD COLUMN caption_options TEXT')
  db.exec(`UPDATE assets SET
    op = COALESCE((SELECT json_extract(j.payload, '$.op') FROM jobs j WHERE j.id = assets.job_id), 'generate'),
    video_engine = (SELECT json_extract(j.payload, '$.videoEngine') FROM jobs j WHERE j.id = assets.job_id)
    WHERE op IS NULL`)
}

const insertJob = db.prepare(`
INSERT INTO jobs (id, created_at, status, persona_id, register, mode, purpose,
                  recipe_id, workflow_file, seed, user_prompt, user_directives,
                  composed_positive, composed_negative, selections, payload, request_id)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

export function createJob(j) {
  insertJob.run(
    j.id, j.createdAt, j.status, j.personaId ?? null, j.register ?? null,
    j.mode ?? null, j.purpose ?? null, j.recipeId ?? null, j.workflowFile ?? null,
    j.seed ?? null, j.userPrompt ?? null, j.userDirectives ?? null,
    j.composedPositive ?? null, j.composedNegative ?? null,
    JSON.stringify(j.selections ?? null),
    JSON.stringify(j),
    j.requestId ?? null,
  )
}

/** Jobs déjà créés pour une clé d'idempotence — vide si la clé est neuve.
 *  Rend les LIGNES (pas le payload) : l'appelant veut les identifiants pour
 *  répondre comme au premier envoi. */
const byRequestStmt = db.prepare(`SELECT id, status FROM jobs WHERE request_id = ?`)
export const jobsByRequestId = rid => (rid ? byRequestStmt.all(rid) : [])

const setStatusStmt = db.prepare(`UPDATE jobs SET status = ? WHERE id = ?`)
export const setStatus = (id, status) => setStatusStmt.run(status, id)

const patchStmt = {
  started:  db.prepare(`UPDATE jobs SET status=?, started_at=?, comfy_prompt_id=? WHERE id=?`),
  finished: db.prepare(`UPDATE jobs SET status=?, finished_at=?, duration_ms=? WHERE id=?`),
  failed:   db.prepare(`UPDATE jobs SET status=?, finished_at=?, duration_ms=?, error=? WHERE id=?`),
}
/** Jobs restés « queued » en base : la file en mémoire au moment d'un arrêt.
 *  Rendus dans l'ordre d'arrivée, payload complet reparsé. */
export const queuedPayloads = () =>
  db.prepare(`SELECT payload FROM jobs WHERE status='queued' AND payload IS NOT NULL
              ORDER BY created_at`).all()
    .map(r => { try { return JSON.parse(r.payload) } catch { return null } })
    .filter(Boolean)

/** Jobs orphelins d'un arrêt en plein rendu, avec ce qu'il faut pour se
 *  RÉ-ATTACHER à leur prompt ComfyUI encore vivant. */
export const orphanedRunningRows = () =>
  db.prepare(`SELECT id, comfy_prompt_id, payload, started_at FROM jobs
              WHERE status IN ('rendering','swap-ref','queued-comfy','post-process','retry')`)
    .all().map(r => ({ id: r.id, comfy_prompt_id: r.comfy_prompt_id, started_at: r.started_at,
      payload: (() => { try { return JSON.parse(r.payload) } catch { return null } })() }))

export const markStarted  = (id, promptId)      => patchStmt.started.run('rendering', Date.now(), promptId, id)
/* Abonnés à la fin d'un job (filtre des rendus) : appelés après l'écriture, sans attendre. */
const finJob = []
export const surFinJob = f => { finJob.push(f) }
export const markFinished = (id, ms) => {
  const r = patchStmt.finished.run('done', Date.now(), ms, id)
  for (const f of finJob) { try { f(id) } catch (e) { console.warn(`[fin de job] ${e.message}`) } }
  return r
}
export const markFailed   = (id, ms, err)       => patchStmt.failed.run('blocked', Date.now(), ms, String(err).slice(0, 4000), id)
/** Remet un job en file depuis son payload : prompt ComfyUI oublié (il
 *  n'existe plus), erreur effacée. Utilisé par la reprise après un
 *  redémarrage de ComfyUI, où le rendu en cours est réellement perdu. */
const requeueStmt = db.prepare(`UPDATE jobs SET status='queued', comfy_prompt_id=NULL,
                                started_at=NULL, finished_at=NULL, error=NULL WHERE id=?`)
export const requeue = id => requeueStmt.run(id)

/* Historique des durées par recette : nourrit l'estimation dynamique
   (moyenne des derniers jobs de même workflow — voir estimateMs). */
const doneDurStmt = db.prepare(`SELECT payload, duration_ms FROM jobs
  WHERE status='done' AND duration_ms IS NOT NULL AND payload IS NOT NULL
    AND json_extract(payload, '$.workflowFile') = ?
  ORDER BY finished_at DESC LIMIT ?`)
export const doneDurations = (workflowFile, limit = 32) => doneDurStmt.all(workflowFile, limit)

const getJobStmt   = db.prepare(`SELECT * FROM jobs WHERE id = ?`)
const listJobsStmt = db.prepare(`SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?`)
export const getJob   = id => getJobStmt.get(id)
/** Jobs d'un même groupe de plans (motion par plans), dans l'ordre d'arrivée. */
export const jobsByPlanGroup = g => db.prepare(`SELECT id, status, payload FROM jobs
  WHERE json_extract(payload, '$.motionPlan.group') = ? ORDER BY created_at, id`).all(g)
export const listJobs = (limit = 50) => listJobsStmt.all(limit)

/* ---------- assets + provenance ---------- */

const insertAsset = db.prepare(`
INSERT INTO assets (id, job_id, created_at, media_type, uri, filename, bytes,
                    width, height, aspect, register, review_status, export_ready, op, video_engine)
VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',0,?,?)`)

const insertProv = db.prepare(`
INSERT INTO provenance (asset_id, job_id, created_at, recipe_id, workflow_file,
                        comfy_prompt_id, seed, composed_positive, composed_negative,
                        user_prompt, user_directives, resolved_text,
                        identity_preamble, register_clause, extra_loras, source_image,
                        selections, injections, workflow_json)
VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)

/** Enregistre l'asset ET sa lignée dans la même transaction :
 *  un média sans provenance n'aurait aucune valeur de production. */
export function createAsset(a, prov) {
  db.exec('BEGIN')
  try {
    insertAsset.run(a.id, a.jobId, a.createdAt, a.mediaType, a.uri, a.filename,
      a.bytes ?? null, a.width ?? null, a.height ?? null, a.aspect ?? null, a.register ?? null,
      a.op ?? 'generate', a.videoEngine ?? null)
    insertProv.run(a.id, a.jobId, a.createdAt, prov.recipeId ?? null, prov.workflowFile ?? null,
      prov.comfyPromptId ?? null, prov.seed ?? null, prov.composedPositive ?? null,
      prov.composedNegative ?? null, prov.userPrompt ?? null, prov.userDirectives ?? null,
      JSON.stringify(prov.resolvedText ?? null),
      JSON.stringify(prov.identityPreamble ?? null), prov.registerClause ?? null,
      JSON.stringify(prov.extraLoras ?? null), prov.sourceImage ?? null,
      JSON.stringify(prov.selections ?? null),
      JSON.stringify(prov.injections ?? null), JSON.stringify(prov.workflowJson ?? null))
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

/* Les assets sont TOUJOURS lus avec leur provenance : c'est elle qui rend
   « Cloner » possible après un rechargement de page (le Job n'est plus en
   mémoire côté front). Le workflow complet, lui, reste hors de cette vue —
   il pèse ~900 Ko et ne sert qu'à la route dédiée. */
/* Contrôle automatique d'un clip rendu (scripts/controle_clip.py) : défauts
   horodatés et score de visage, par asset. Créée avant ASSET_SELECT, qui la lit. */
db.exec(`CREATE TABLE IF NOT EXISTS controles (asset_id TEXT PRIMARY KEY, job_id TEXT, data TEXT NOT NULL, at INTEGER NOT NULL)`)
const ecrireControleStmt = db.prepare('INSERT INTO controles (asset_id, job_id, data, at) VALUES (?, ?, ?, ?) ON CONFLICT(asset_id) DO UPDATE SET data = excluded.data, at = excluded.at')
const lireControleStmt = db.prepare('SELECT data FROM controles WHERE asset_id = ?')
export function ecrireControle(assetId, jobId, data) { ecrireControleStmt.run(String(assetId), String(jobId), JSON.stringify(data), Date.now()) }
export function lireControle(assetId) { try { return JSON.parse(lireControleStmt.get(String(assetId))?.data ?? 'null') } catch { return null } }

const ASSET_SELECT = `
SELECT a.*, p.recipe_id, p.seed, p.composed_positive, p.composed_negative,
       p.user_prompt, p.user_directives, p.selections,
       j.duration_ms AS render_ms, j.persona_id AS persona_id,
       p.workflow_file AS workflow_file,
       json_extract(j.payload, '$.loras') AS job_loras,
       json_extract(j.payload, '$.videoLoras') AS job_video_loras,
       json_extract(j.payload, '$.videoDraft') AS video_draft,
       json_extract(j.payload, '$.batchId') AS batch_id,
       json_extract(j.payload, '$.parentAssetId') AS parent_asset_id,
       json_extract(j.payload, '$.origineUri') AS origine_uri,
       json_extract(j.payload, '$.batchIds') AS batch_ids,
       json_extract(j.payload, '$.carouselLocks') AS carousel_locks,
       json_extract(j.payload, '$.initialBrief') AS initial_brief,
       json_extract(j.payload, '$.promptVision') AS prompt_vision,
       json_extract(j.payload, '$.videoFps') AS video_fps,
       json_extract(j.payload, '$.withAudio') AS with_audio,
       json_extract(j.payload, '$.t2v') AS t2v,
       json_extract(j.payload, '$.photoEngine') AS photo_engine,
       json_extract(j.payload, '$.op') AS job_op,
       (SELECT json_group_array(folder_id) FROM folder_assets fa WHERE fa.asset_id = a.id) AS folder_ids,
       (SELECT data FROM controles c WHERE c.asset_id = a.id) AS controle
FROM assets a LEFT JOIN provenance p ON p.asset_id = a.id
              LEFT JOIN jobs j ON j.id = a.job_id`

const assetsOfJobStmt = db.prepare(`${ASSET_SELECT} WHERE a.job_id = ? ORDER BY a.created_at`)
const listAssetsStmt  = db.prepare(`${ASSET_SELECT} ORDER BY a.created_at DESC LIMIT ?`)
const listAssetsPersonaStmt = db.prepare(`${ASSET_SELECT} WHERE j.persona_id = ? ORDER BY a.created_at DESC LIMIT ?`)
const getProvStmt     = db.prepare(`SELECT * FROM provenance WHERE asset_id = ?`)
export const assetsOfJob = jobId => assetsOfJobStmt.all(jobId)
/** `personaId` : les rendus d'un seul personnage ; absent, tous. */
export const listAssets  = (limit = 200, personaId) =>
  personaId ? listAssetsPersonaStmt.all(personaId, limit) : listAssetsStmt.all(limit)
export const getProvenance = id => getProvStmt.get(id)

/* ---------- dossiers (collections d'assets, appartenances multiples) ---------- */
/* Dossiers cloisonnés par personnage : sans persona_id, les dossiers
   d'un personnage apparaissaient chez tous les autres. Un dossier existant
   sans personnage prend celui de la majorité de ses rendus ; un dossier vide,
   celui qui le crée ensuite (rattaché à la première liste qui le voit). */
try { db.exec('ALTER TABLE folders ADD COLUMN persona_id TEXT') } catch { /* déjà là */ }
db.exec(`UPDATE folders SET persona_id = (
    SELECT j.persona_id FROM folder_assets fa JOIN assets a ON a.id = fa.asset_id JOIN jobs j ON j.id = a.job_id
    WHERE fa.folder_id = folders.id AND j.persona_id IS NOT NULL
    GROUP BY j.persona_id ORDER BY COUNT(*) DESC LIMIT 1)
  WHERE persona_id IS NULL`)

/** `personaId` absent : tous les dossiers (outils internes). */
export function listFolders(personaId) {
  const filtre = personaId ? 'WHERE f.persona_id = ?' : ''
  return db.prepare(`SELECT f.id, f.name, f.created_at, f.persona_id,
    (SELECT COUNT(*) FROM folder_assets fa JOIN assets a ON a.id = fa.asset_id
      WHERE fa.folder_id = f.id) AS count
    FROM folders f ${filtre} ORDER BY f.created_at DESC`).all(...(personaId ? [personaId] : []))
}
export function createFolder(name, personaId = null) {
  /* nom dupliqué (chez le même personnage) → suffixe chiffré (« Aout 2026 » existe ⇒ « Aout 2026 2 ») */
  const base = String(name).trim()
  const names = new Set(db.prepare('SELECT name FROM folders WHERE persona_id IS ?').all(personaId).map(r => r.name))
  let final = base, n = 2
  while (names.has(final)) final = `${base} ${n++}`
  const id = `f-${Date.now().toString(36)}`
  db.prepare('INSERT INTO folders (id, name, created_at, persona_id) VALUES (?,?,?,?)').run(id, final, Date.now(), personaId)
  return { id, name: final, created_at: Date.now(), count: 0 }
}
export function renameFolder(id, name) {
  return db.prepare('UPDATE folders SET name = ? WHERE id = ?').run(String(name).trim(), id).changes > 0
}
export function deleteFolder(id) {
  db.prepare('DELETE FROM folder_assets WHERE folder_id = ?').run(id)
  return db.prepare('DELETE FROM folders WHERE id = ?').run(id).changes > 0
}
export function folderToggle(folderId, addIds = [], removeIds = []) {
  const add = db.prepare('INSERT OR IGNORE INTO folder_assets (folder_id, asset_id, added_at) VALUES (?,?,?)')
  const rem = db.prepare('DELETE FROM folder_assets WHERE folder_id = ? AND asset_id = ?')
  for (const a of addIds) add.run(folderId, a, Date.now())
  for (const a of removeIds) rem.run(folderId, a)
  return { added: addIds.length, removed: removeIds.length }
}

const getAssetStmt = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`)
export const getAsset = id => getAssetStmt.get(id)

/* Suppression d'un asset. La provenance part avec lui : la garder seule
   laisserait une ligne qui décrit une image qui n'existe plus, et
   `/api/assets/:id/provenance` répondrait sur un asset absent de la galerie.
   Le fichier sur disque est effacé par l'appelant — la base ne connaît pas
   le dossier des médias, et l'inverse ferait de db.js un gestionnaire de
   fichiers. */
const delAssetStmt = db.prepare(`DELETE FROM assets WHERE id = ?`)
const delProvStmt  = db.prepare(`DELETE FROM provenance WHERE asset_id = ?`)
/** Fichiers médias d'un job (pour les effacer avant la suppression). */
const jobFilesStmt = db.prepare(`SELECT filename FROM assets WHERE job_id = ?`)
export const jobAssetFiles = id => jobFilesStmt.all(id).map(r => r.filename).filter(Boolean)

/** Suppression PROFONDE d'un job : la ligne job, et par cascade ses assets
 *  et leurs provenances. Les fichiers disque sont effacés par l'appelant
 *  (route), AVANT, pendant que la base les connaît encore. */
const delJobStmt = db.prepare(`DELETE FROM jobs WHERE id = ?`)
export function deleteJobDeep(id) {
  const n = jobFilesStmt.all(id).length
  const r = delJobStmt.run(id)
  return { removed: r.changes > 0, assetsRemoved: n }
}

/* ---------- briefs récents et étoilés ----------
   L'historique n'est pas stocké à part : ce sont les briefs des jobs. Seules
   les étoiles ont leur table (un brief étoilé survit à la suppression du job). */
db.exec(`CREATE TABLE IF NOT EXISTS briefs_etoiles (texte TEXT PRIMARY KEY, mode TEXT, at INTEGER NOT NULL)`)
export function listBriefs(limit = 400) {
  const recents = db.prepare(`SELECT user_prompt AS texte, mode, register, MAX(created_at) AS at, COUNT(*) AS n
    FROM jobs WHERE user_prompt IS NOT NULL AND TRIM(user_prompt) != '' GROUP BY user_prompt ORDER BY at DESC LIMIT ?`).all(limit)
  const etoiles = db.prepare('SELECT texte, mode, at FROM briefs_etoiles').all()
  const vus = new Set(recents.map(r => r.texte))
  const marque = new Set(etoiles.map(e => e.texte))
  return [...recents.map(r => ({ ...r, star: marque.has(r.texte) })),
    ...etoiles.filter(e => !vus.has(e.texte)).map(e => ({ texte: e.texte, mode: e.mode, register: null, at: e.at, n: 0, star: true }))]
}
export function starBrief(texte, mode, on) {
  if (on) db.prepare('INSERT OR REPLACE INTO briefs_etoiles (texte, mode, at) VALUES (?, ?, ?)').run(texte, mode ?? null, Date.now())
  else db.prepare('DELETE FROM briefs_etoiles WHERE texte = ?').run(texte)
}

/* ---------- corbeille ----------
   Supprimer un asset ne l'efface plus tout de suite : sa ligne, sa provenance
   et ses dossiers sont photographiés en JSON dans `corbeille`, puis retirés
   des tables vivantes (aucune requête de la galerie n'a donc à changer). Le
   fichier est déplacé par l'appelant. Restauration possible tant que la purge
   (30 jours) n'est pas passée et que le job d'origine existe encore. */
db.exec(`CREATE TABLE IF NOT EXISTS corbeille (
  asset_id TEXT PRIMARY KEY, deleted_at INTEGER NOT NULL, filename TEXT, donnees TEXT NOT NULL)`)
const inserer = (table, row) => {
  const cols = Object.keys(row)
  db.prepare(`INSERT OR REPLACE INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map(c => row[c]))
}
export function trashAsset(id) {
  const asset = db.prepare('SELECT * FROM assets WHERE id = ?').get(id)
  if (!asset) return null
  const donnees = {
    asset,
    provenance: db.prepare('SELECT * FROM provenance WHERE asset_id = ?').get(id) ?? null,
    dossiers: db.prepare('SELECT * FROM folder_assets WHERE asset_id = ?').all(id),
  }
  db.prepare('INSERT OR REPLACE INTO corbeille (asset_id, deleted_at, filename, donnees) VALUES (?, ?, ?, ?)')
    .run(id, Date.now(), asset.filename ?? null, JSON.stringify(donnees))
  deleteAsset(id)
  return asset
}
export function restoreAsset(id) {
  const c = db.prepare('SELECT * FROM corbeille WHERE asset_id = ?').get(id)
  if (!c) return { error: 'absent de la corbeille' }
  const d = JSON.parse(c.donnees)
  if (!db.prepare('SELECT 1 FROM jobs WHERE id = ?').get(d.asset.job_id)) return { error: 'le job d’origine a été supprimé' }
  db.exec('BEGIN')
  try {
    inserer('assets', d.asset)
    if (d.provenance) inserer('provenance', d.provenance)
    for (const f of d.dossiers ?? [])
      if (db.prepare('SELECT 1 FROM folders WHERE id = ?').get(f.folder_id)) inserer('folder_assets', f)
    db.prepare('DELETE FROM corbeille WHERE asset_id = ?').run(id)
    db.exec('COMMIT')
  } catch (e) { db.exec('ROLLBACK'); throw e }
  return { filename: c.filename }
}
export const trashList = () => db.prepare('SELECT asset_id, deleted_at, filename FROM corbeille ORDER BY deleted_at DESC').all()
export const trashForget = id => db.prepare('DELETE FROM corbeille WHERE asset_id = ?').run(id)

export function deleteAsset(id) {
  db.exec('BEGIN')
  try {
    delProvStmt.run(id)
    const r = delAssetStmt.run(id)
    db.exec('COMMIT')
    return r.changes > 0
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

const reviewStmt = db.prepare(`UPDATE assets SET review_status = ? WHERE id = ?`)
const exportStmt = db.prepare(`UPDATE assets SET export_ready = ? WHERE id = ?`)
export const setReview = (id, status) => reviewStmt.run(status, id)
export const setExportReady = (id, v) => exportStmt.run(v ? 1 : 0, id)

/* Reclassement d'un asset. Ne touche QUE la colonne `register` de l'asset :
   ni le job, ni la provenance. Le job a bien tourné sous son registre
   d'origine, avec le préambule et l'instruction de ce registre-là — réécrire
   la provenance rendrait le rendu inexplicable après coup.
   Ce qu'on corrige ici, c'est la DESTINATION du média, pas son histoire. */
const registerStmt = db.prepare(`UPDATE assets SET register = ? WHERE id = ?`)
export const setAssetRegister = (id, register) => registerStmt.run(register, id)

const captionStmt = db.prepare(`UPDATE assets SET caption = ? WHERE id = ?`)
const captionOptsStmt = db.prepare(`UPDATE assets SET caption = ?, caption_options = ? WHERE id = ?`)
export const setCaption = (id, texte) => captionStmt.run(texte || null, id)
export const setCaptionProposee = (id, texte, options) => captionOptsStmt.run(texte, JSON.stringify(options), id)
/** Assets d'un dossier, dans l'ordre où ils y sont entrés. */
export const assetsOfFolder = folderId => db.prepare(`${ASSET_SELECT}
  JOIN folder_assets fx ON fx.asset_id = a.id WHERE fx.folder_id = ? ORDER BY fx.added_at`).all(folderId)
export const getFolder = id => db.prepare('SELECT * FROM folders WHERE id = ?').get(id)


/* Pose un batchId dans le payload d'un job existant (carrousel —
   l'original rejoint le lot sans re-génération). */
/* Un job peut appartenir à PLUSIEURS lots (une still qui sert d'origine à
   plusieurs carrousels) : on APPEND dans payload.batchIds au lieu d'écraser
   payload.batchId (qui reste l'appartenance de création, intouchée). */
const getPayloadStmt = db.prepare(`SELECT payload FROM jobs WHERE id = ?`)
const setPayloadStmt = db.prepare(`UPDATE jobs SET payload = ? WHERE id = ?`)
export function setJobBatchId(id, batchId) {
  const row = getPayloadStmt.get(id)
  if (!row) return false
  let p
  try { p = JSON.parse(row.payload) } catch { return false }
  const ids = new Set([...(Array.isArray(p.batchIds) ? p.batchIds : []), batchId])
  p.batchIds = [...ids]
  setPayloadStmt.run(JSON.stringify(p), id)
  return true
}

/* Fichiers déposés par LE STUDIO dans le dossier input de ComfyUI.
   Ce dossier est partagé avec l'instance privée : le lister tel quel montrait
   les uploads et frames de l'autre instance. On ne liste et ne sert donc que
   les noms inscrits ici. Premier passage : on reprend les noms déjà cités par
   les jobs du studio, pour ne pas vider l'onglet Uploads existant. */
const inputsNeuf = !db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'inputs_studio'`).get()
db.exec(`CREATE TABLE IF NOT EXISTS inputs_studio (nom TEXT PRIMARY KEY, at INTEGER NOT NULL)`)
const noterInputStmt = db.prepare('INSERT OR IGNORE INTO inputs_studio (nom, at) VALUES (?, ?)')
if (inputsNeuf) {
  const noms = new Set()
  for (const { payload } of db.prepare('SELECT payload FROM jobs WHERE payload IS NOT NULL').all())
    for (const m of String(payload).matchAll(/crs_[\w.-]+?\.(?:png|jpe?g|webp|mp4|mov|webm)/gi)) noms.add(m[0])
  for (const n of noms) noterInputStmt.run(n, Date.now())
}
/* Origine de chaque dépôt : « genere » pour ce que le studio tire de ses
   propres rendus (still, première/dernière image, suite), « upload » pour un
   fichier envoyé, « voix » pour une voix. Un visiteur ne part que de « genere ».
   Les noms d'avant cette colonne sont classés par leur forme ; une image tirée
   d'une vidéo dont on ignore la source reste « inconnu », donc refusée. */
if (!db.prepare(`SELECT 1 FROM pragma_table_info('inputs_studio') WHERE name = 'origine'`).get())
  db.exec(`ALTER TABLE inputs_studio ADD COLUMN origine TEXT`)
db.exec(`UPDATE inputs_studio SET origine = CASE
    WHEN nom LIKE 'crs!_still!_%' ESCAPE '!' OR nom LIKE 'crs!_suite!_%' ESCAPE '!' THEN 'genere'
    WHEN nom LIKE 'crs!_voix!_%' ESCAPE '!' THEN 'voix'
    WHEN nom LIKE 'crs!_lastframe!_%' ESCAPE '!' OR nom LIKE 'crs!_firstframe!_%' ESCAPE '!' THEN 'inconnu'
    ELSE 'upload' END
  WHERE origine IS NULL`)
const noterInputOrigineStmt = db.prepare('INSERT INTO inputs_studio (nom, at, origine) VALUES (?, ?, ?) ON CONFLICT(nom) DO UPDATE SET origine = excluded.origine')
export function noterInput(nom, origine = 'genere') { noterInputOrigineStmt.run(String(nom), Date.now(), origine) }
const estInputStmt = db.prepare('SELECT origine FROM inputs_studio WHERE nom = ?')
export function estInputStudio(nom) { return !!estInputStmt.get(String(nom)) }
export function origineInput(nom) { return estInputStmt.get(String(nom))?.origine ?? null }
export function estInputGenere(nom) { return origineInput(nom) === 'genere' }
/** Ce qu'un visiteur peut prendre comme source : les rendus du studio et ses propres dépôts contrôlés (sans personne). */
export function estInputVisiteur(nom) { return ['genere', 'depot-visiteur'].includes(origineInput(nom)) }
const origineRestaureeStmt = db.prepare("SELECT 1 FROM jobs WHERE json_extract(payload, '$.origineUri') = ? LIMIT 1")
/** L'envoi est la source d'une restauration : son avant / après se montre avec le rendu. */
export function estOrigineRestauree(nom) { return !!origineRestaureeStmt.get(`/api/uploads/${encodeURIComponent(String(nom))}`) }

/** Montages et reels qui emploient ce son (musique ou voix off), par leur nom. */
const sonDansMontagesStmt = db.prepare("SELECT nom FROM montages WHERE instr(data, ?) > 0")
const sonDansReelsStmt = db.prepare("SELECT brief AS nom FROM reels WHERE instr(data, ?) > 0")
export function usagesSon(nom) {
  return [...sonDansMontagesStmt.all(String(nom)), ...sonDansReelsStmt.all(String(nom))].map(r => String(r.nom ?? '').slice(0, 60))
}
