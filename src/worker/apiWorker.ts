/* ============================================================
   Worker réel (§8) — implémente GenerationWorker.

   Le job part sur /api/jobs (backend Fastify), qui le sérialise
   vers ComfyUI. On suit ensuite l'avancement
   par interrogation périodique, et on émet l'Asset réel — dont
   l'`uri` pointe sur une image servie depuis /media.
   ============================================================ */
import type { GenerationWorker, Job, Asset, MediaMode, Register, CaptionOption } from '../types'

type UpdateCb = (job: Job, asset?: Asset) => void

/** Réponse de /api/assets et /api/jobs/:id (contrat backend). */
export interface ApiAsset {
  /** Recette, moteur, opération et LoRA, en minuscules : pour la recherche. */
  search?: string
  id: string
  jobId: string
  personaId?: string | null
  createdAt: number
  mediaType: MediaMode
  uri: string
  width: number | null
  height: number | null
  aspect: string | null
  register: Register
  reviewStatus: Asset['reviewStatus']
  exportReady: boolean
  op?: Asset['op']
  videoEngine?: Asset['videoEngine']
  videoDraft?: boolean
  withAudio?: boolean
  t2v?: boolean
  photoEngine?: Asset['photoEngine']
  postOp?: Asset['postOp']
  modele3d?: string
  batchId?: string
  parentAssetId?: string
  origineUri?: string
  batchIds?: string[]
  batchLocks?: Record<string, boolean>
  renderMs?: number | null
  /* Provenance jointe par GET /api/assets — c'est elle qui rend clonable
     un asset rechargé depuis la base (le Job n'est plus en mémoire). */
  recipeId?: string
  seed?: Job['seed']
  selections?: Job['selections']
  composedPositive?: string
  composedNegative?: string
  userPrompt?: string
  userDirectives?: string
  initialBrief?: string
  promptVision?: string
  videoFps?: number
  caption?: string
  captionOptions?: CaptionOption[]
  controle?: Asset['controle']
  folders?: string[]
}

interface ApiJob {
  id: string
  status: string
  startedAt?: number | null
  estimatedMs?: number | null
  progress?: { value: number; max: number; etaS: number | null }
  phase?: string
  apercu?: number
  file?: { rang: number; attenteMs: number }
  durationMs: number | null
  error: string | null
  seed: number | null
  recipeId: string | null
  composedPositive: string | null
  composedNegative: string | null
  selections: Job['selections'] | null
}

/** Cadence d'interrogation : une image prend ~25 s, une seconde suffit. */
const POLL_MS = 1000
/** Statuts terminaux côté backend. */
const TERMINAL = new Set(['done', 'blocked'])

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

/** Convertit un asset backend en Asset du modèle front, en rattachant
 *  la provenance portée par le job (le backend la stocke aussi en base). */
export function toAsset(a: ApiAsset, job?: Partial<Job>): Asset {
  return {
    id: a.id,
    jobId: a.jobId,
    personaId: a.personaId ?? null,
    mediaType: a.mediaType,
    uri: a.uri,
    aspect: a.aspect ?? '9:16',
    width: a.width ?? undefined,
    height: a.height ?? undefined,
    register: 'sfw',
    provenance: {
      selections: (job?.selections ?? a.selections ?? {}) as Job['selections'],
      /* La seed RÉELLEMENT tirée gagne. Le job local garde `{mode:'random'}`
         sans valeur tant que le serveur n'a pas répondu : préféré tel quel,
         il masquait la seed de l'asset et la vue détail affichait
         « aléatoire » sur des rendus terminés. */
      seed: (job?.seed?.value != null ? job.seed : undefined) ?? a.seed ?? job?.seed ?? { mode: 'random' },
      recipeId: job?.recipeId ?? a.recipeId ?? '',
      composedPositive: job?.composedPositive ?? a.composedPositive ?? '',
      composedNegative: job?.composedNegative ?? a.composedNegative ?? '',
      // Indispensables au clonage : sans eux le champ « Prompt image »
      // ne peut pas être repeuplé (cf. store.cloneFrom).
      userPrompt: job?.userPrompt ?? a.userPrompt ?? '',
      userDirectives: job?.userDirectives ?? a.userDirectives ?? '',
      initialBrief: job?.initialBrief ?? a.initialBrief ?? undefined,
      promptVision: job?.promptVision ?? a.promptVision ?? undefined,
    },
    reviewStatus: a.reviewStatus,
    exportReady: a.exportReady,
    createdAt: a.createdAt,
    op: a.op,
    videoEngine: a.videoEngine,
    search: a.search,
    videoDraft: a.videoDraft || undefined,
    withAudio: a.withAudio || undefined,
    t2v: a.t2v || undefined,
    photoEngine: a.photoEngine || undefined,
    postOp: a.postOp || undefined,
    modele3d: a.modele3d || undefined,
    batchId: a.batchId || undefined,
    parentAssetId: a.parentAssetId || undefined,
    origineUri: a.origineUri || undefined,
    batchIds: a.batchIds || undefined,
    batchLocks: a.batchLocks || undefined,
    renderMs: a.renderMs ?? undefined,
    videoFps: a.videoFps ?? undefined,
    folders: a.folders ?? undefined,
    caption: a.caption ?? undefined,
    captionOptions: a.captionOptions ?? undefined,
    // contrôle automatique du clip (server/controle.js), absent tant qu'il n'a pas tourné
    controle: a.controle ?? undefined,
  }
}

class ApiWorker implements GenerationWorker {
  private listeners = new Set<UpdateCb>()

  async submit(job: Job): Promise<void> {
    try {
      const r = await api<{ id?: string; duplicate?: boolean }>('/api/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(job),
      })
      /* Clé déjà vue sur un AUTRE job : ce n'est pas une reprise de celui-ci,
         il n'existe pas et n'existera pas. On le dit, au lieu d'interroger
         sans fin un identifiant inconnu du serveur. */
      if (r?.duplicate && r.id && r.id !== job.id) {
        console.error(`[worker] ${job.id} non créé : même clé d'envoi que #${r.id}`)
        this.emit({ ...job, status: 'blocked' })
        return
      }
    } catch (e) {
      // Refus immédiat (prompt vide, backend absent) : le job est bloqué,
      // on le dit au front plutôt que de le laisser « queued » pour toujours.
      this.emit({ ...job, status: 'blocked', error: String((e as Error)?.message ?? e), refusEnvoi: true } as Job)
      console.error('[worker] refus du backend :', e)
      return
    }
    this.poll(job)
  }

  /** Interroge jusqu'à un statut terminal et relaie chaque transition. */
  /** Jobs déjà suivis : un seul suivi par job, même si l'état est rechargé
   *  plusieurs fois (resynchronisation au retour sur l'onglet). */
  private suivis = new Set<string>()

  private poll(job: Job) {
    if (this.suivis.has(job.id)) return
    this.suivis.add(job.id)
    let last = ''
    let lastPhase: string | undefined
    let lastApercu: number | undefined
    let lastRang: number | undefined
    let pannes = 0
    /* Le suivi ne doit JAMAIS mourir en silence : une exception hors de
       l'appel réseau (réponse inattendue, erreur à l'émission) arrêterait la
       boucle, et la carte resterait « en rendu » avec un chrono qui tourne. Toute
       erreur relance le suivi ; on n'abandonne qu'après 40 échecs de suite. */
    const tick = async () => {
      try {
        if (await pas()) this.suivis.delete(job.id)
        else setTimeout(tick, POLL_MS)
        pannes = 0
      } catch (e) {
        if (++pannes > 40) { this.suivis.delete(job.id); console.error(`[job ${job.id}] suivi abandonné`, e); return }
        setTimeout(tick, POLL_MS * 3)   // backend indisponible ou réponse illisible
      }
    }
    /** Un pas de suivi ; rend true quand le job est terminé. */
    const pas = async (): Promise<boolean> => {
      const r: { job: ApiJob; assets: ApiAsset[] } = await api(`/api/jobs/${encodeURIComponent(job.id)}`)
      const status = r.job.status as Job['status']
      const done = TERMINAL.has(r.job.status)

      /* En mode aléatoire, la seed est tirée par le backend : le job local
         part avec `value: undefined`. On la rapatrie, sinon un rendu vu à
         l'écran n'est plus reproductible — ni par verrou, ni par clonage. */
      const withSeed = (j: Job): Job => ({
        ...(Number.isFinite(r.job.seed as number) ? { ...j, seed: { mode: j.seed.mode, value: r.job.seed as number } } : j),
        // Horodatage du rendu : « en rendu depuis » et « rendu en » dans la file.
        startedAt: r.job.startedAt ?? j.startedAt ?? null,
        durationMs: r.job.durationMs ?? j.durationMs ?? null,
        estimatedMs: r.job.estimatedMs ?? j.estimatedMs ?? null,
      })

      if (done) {
        if (r.job.error) console.error(`[job ${job.id}] ${r.job.error}`)
        const updated: Job = withSeed({ ...job, status, error: r.job.error ?? null })
        // Un job peut produire plusieurs images : on les émet toutes.
        if (r.assets.length) r.assets.forEach(a => this.emit(updated, toAsset(a, job)))
        else this.emit(updated)
        return true
      }
      /* La progression change à chaque pas d'échantillonnage : on émet aussi
         quand elle bouge, sinon la barre resterait figée sur « rendering ». */
      const prog = r.job.progress
      if (status !== last || prog || r.job.phase !== lastPhase || r.job.apercu !== lastApercu || r.job.file?.rang !== lastRang) {
        last = status
        lastPhase = r.job.phase
        lastApercu = r.job.apercu
        lastRang = r.job.file?.rang
        this.emit(withSeed({ ...job, status, progress: prog, phase: r.job.phase, apercu: r.job.apercu, file: r.job.file }))
      }
      return false
    }
    setTimeout(tick, 300)
  }

  /** Reprend le SUIVI d'un job déjà soumis (rechargement de page, autre
   *  appareil) : même boucle d'interrogation que submit, sans re-soumettre.
   *  Le serveur est la source de vérité — le front ne fait que s'y abonner. */
  adopt(job: Job): void {
    this.poll(job)
  }

  onUpdate(cb: UpdateCb): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(job: Job, asset?: Asset) {
    this.listeners.forEach(cb => cb(job, asset))
  }
}

const apiWorkerInstance = new ApiWorker()
export const worker: GenerationWorker & { adopt: (job: Job) => void } = apiWorkerInstance

/** Charge la bibliothèque persistée au démarrage (SQLite → galerie). */
/** Assets d'un autre personnage, ou de tous (`'all'`) — le montage en a besoin
 *  pour un plan qui ne vient pas de la bibliothèque affichée. */
export async function fetchAssetsDe(persona: string): Promise<Asset[]> {
  const { assets } = await api<{ assets: ApiAsset[] }>(`/api/assets?limit=5000&persona=${encodeURIComponent(persona)}`)
  return assets.map(a => toAsset(a))
}

export async function fetchAssets(): Promise<Asset[]> {
  const { assets } = await api<{ assets: ApiAsset[] }>('/api/assets?limit=3000&persona=all')
  return assets.map(a => toAsset(a))
}

/** Supprime un asset : ligne, provenance ET fichier sur disque.
 *  Irréversible — l'appelant confirme avant. */
export async function deleteAsset(id: string) {
  await api(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Annule un job : retiré de la file s'il attend, interrompu s'il tourne.
 *  409 = déjà terminé — l'appelant l'affiche, ce n'est pas une erreur grave. */
export async function cancelJob(id: string) {
  await api(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Écrit la revue manuelle en base (le front n'est plus la source de vérité). */
export async function pushReview(id: string, patch: {
  reviewStatus?: Asset['reviewStatus']
  exportReady?: boolean
  caption?: string
}) {
  await api(`/api/assets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
}
