/* ============================================================
   API worker — implements GenerationWorker.

   The job is posted to /api/jobs (Fastify backend), which serializes
   it to ComfyUI. Progress is then polled, and the resulting Asset is
   emitted — its `uri` points to an image served from /media.
   ============================================================ */
import type { GenerationWorker, Job, Asset, MediaMode, Register, CaptionOption } from '../types'

type UpdateCb = (job: Job, asset?: Asset) => void

/** Response of /api/assets and /api/jobs/:id (backend contract). */
export interface ApiAsset {
  /** Recipe, engine, operation and LoRA, lowercased: for search. */
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
  /* Provenance joined by GET /api/assets — it makes an asset reloaded
     from the database clonable (the Job is no longer in memory). */
  recipeId?: string
  seed?: Job['seed']
  selections?: Job['selections']
  composedPositive?: string
  composedNegative?: string
  userPrompt?: string
  userDirectives?: string
  initialBrief?: string
  promptVision?: string
  promptReecrit?: string
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

/** Polling interval: an image takes ~25 s, one second is enough. */
const POLL_MS = 1000
/** Backend terminal statuses. */
const TERMINAL = new Set(['done', 'blocked'])

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`)
  return body as T
}

/** Converts a backend asset into a front-end Asset, attaching the
 *  provenance carried by the job (the backend also stores it in the database). */
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
      /* The seed ACTUALLY drawn wins. The local job keeps `{mode:'random'}`
         with no value until the server responds; using it would hide the
         asset's seed. */
      seed: (job?.seed?.value != null ? job.seed : undefined) ?? a.seed ?? job?.seed ?? { mode: 'random' },
      recipeId: job?.recipeId ?? a.recipeId ?? '',
      composedPositive: job?.composedPositive ?? a.composedPositive ?? '',
      composedNegative: job?.composedNegative ?? a.composedNegative ?? '',
      // Required for cloning: without them the "Prompt image" field
      // cannot be repopulated (see store.cloneFrom).
      userPrompt: job?.userPrompt ?? a.userPrompt ?? '',
      userDirectives: job?.userDirectives ?? a.userDirectives ?? '',
      initialBrief: job?.initialBrief ?? a.initialBrief ?? undefined,
      promptVision: job?.promptVision ?? a.promptVision ?? undefined,
      promptReecrit: (job as { promptReecrit?: string } | undefined)?.promptReecrit ?? a.promptReecrit ?? undefined,
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
    // automatic clip check (server/controle.js), absent until it has run
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
      /* Key already seen on ANOTHER job: this is not a resume of this one,
         it does not exist. Report it instead of polling an id unknown to
         the server forever. */
      if (r?.duplicate && r.id && r.id !== job.id) {
        console.error(`[worker] ${job.id} non créé : même clé d'envoi que #${r.id}`)
        this.emit({ ...job, status: 'blocked' })
        return
      }
    } catch (e) {
      // Immediate rejection (empty prompt, backend missing): the job is blocked,
      // report it to the front end instead of leaving it "queued" forever.
      this.emit({ ...job, status: 'blocked', error: String((e as Error)?.message ?? e), refusEnvoi: true } as Job)
      console.error('[worker] refus du backend :', e)
      return
    }
    this.poll(job)
  }

  /** Polls until a terminal status and relays each transition. */
  /** Jobs already tracked: one tracker per job, even if state is reloaded
   *  several times (resync when the tab regains focus). */
  private suivis = new Set<string>()

  private poll(job: Job) {
    if (this.suivis.has(job.id)) return
    this.suivis.add(job.id)
    let last = ''
    let lastPhase: string | undefined
    let lastApercu: number | undefined
    let lastRang: number | undefined
    let pannes = 0
    /* Tracking must NEVER die silently: an exception outside the network call
       (unexpected response, emit error) would stop the loop and leave the
       card "rendering" forever. Any error restarts tracking; it gives up only
       after 40 consecutive failures. */
    const tick = async () => {
      try {
        if (await pas()) this.suivis.delete(job.id)
        else setTimeout(tick, POLL_MS)
        pannes = 0
      } catch (e) {
        if (++pannes > 40) { this.suivis.delete(job.id); console.error(`[job ${job.id}] suivi abandonné`, e); return }
        setTimeout(tick, POLL_MS * 3)   // backend unavailable or unreadable response
      }
    }
    /** One tracking step; returns true when the job is finished. */
    const pas = async (): Promise<boolean> => {
      const r: { job: ApiJob; assets: ApiAsset[] } = await api(`/api/jobs/${encodeURIComponent(job.id)}`)
      const status = r.job.status as Job['status']
      const done = TERMINAL.has(r.job.status)

      /* In random mode the backend draws the seed: the local job starts with
         `value: undefined`. Fetch it back, otherwise an on-screen render is
         not reproducible (by lock or clone). */
      const withSeed = (j: Job): Job => ({
        ...(Number.isFinite(r.job.seed as number) ? { ...j, seed: { mode: j.seed.mode, value: r.job.seed as number } } : j),
        // Render timestamps: "rendering since" and "rendered in" in the queue.
        startedAt: r.job.startedAt ?? j.startedAt ?? null,
        durationMs: r.job.durationMs ?? j.durationMs ?? null,
        estimatedMs: r.job.estimatedMs ?? j.estimatedMs ?? null,
      })

      if (done) {
        if (r.job.error) console.error(`[job ${job.id}] ${r.job.error}`)
        const updated: Job = withSeed({ ...job, status, error: r.job.error ?? null })
        // A job can produce several images: emit all of them.
        if (r.assets.length) r.assets.forEach(a => this.emit(updated, toAsset(a, job)))
        else this.emit(updated)
        return true
      }
      /* Progress changes on every sampling step: also emit when it moves,
         otherwise the bar would stay stuck on "rendering". */
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

  /** Resumes TRACKING of an already-submitted job (page reload, other
   *  device): same polling loop as submit, without resubmitting.
   *  The server is the source of truth; the front end only subscribes. */
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

/** Loads the persisted library at startup (SQLite → gallery). */
/** Assets of another character, or of all (`'all'`) — editing needs them
 *  for a shot not from the displayed library. */
export async function fetchAssetsDe(persona: string): Promise<Asset[]> {
  const { assets } = await api<{ assets: ApiAsset[] }>(`/api/assets?limit=5000&persona=${encodeURIComponent(persona)}`)
  return assets.map(a => toAsset(a))
}

export async function fetchAssets(): Promise<Asset[]> {
  const { assets } = await api<{ assets: ApiAsset[] }>('/api/assets?limit=3000&persona=all')
  return assets.map(a => toAsset(a))
}

/** Deletes an asset: row, provenance AND file on disk.
 *  Irreversible — the caller confirms first. */
export async function deleteAsset(id: string) {
  await api(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Cancels a job: removed from the queue if waiting, interrupted if running.
 *  409 = already finished — the caller shows it, not a serious error. */
export async function cancelJob(id: string) {
  await api(`/api/jobs/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

/** Writes the manual review to the database (the server is the source of truth). */
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
