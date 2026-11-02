/* ============================================================
   Design system — primitives UI.
   Variants via cva, tokens depuis index.css.
   Tout composant d'écran DOIT passer par ces primitives pour
   garantir cohérence visuelle et ergonomie.
   ============================================================ */
import { type ReactNode, type ComponentProps, useState, useRef, useEffect } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../../lib/cn'
import { t } from '../../i18n'

/* ---------- SectionTitle : intertitre de colonne ---------- */
export function SectionTitle({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('text-[12px] uppercase tracking-[0.09em] text-faint font-bold mb-2', className)}>
      {children}
    </div>
  )
}

/* ---------- Button ---------- */
const buttonVariants = cva(
  'rounded-ctl font-semibold cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed',
  {
    variants: {
      variant: {
        primary: 'bg-accent text-[#0b1017] hover:bg-[#5fa0e6]',
        ghost: 'bg-surface2 border border-border2 text-text hover:bg-surface3',
        danger: 'bg-transparent border border-alert/40 text-alert hover:bg-alert/10',
      },
      size: {
        md: 'px-4 py-2 text-[12.5px]',
        sm: 'px-3 py-1.5 text-[12px]',
        full: 'w-full py-2 text-[12.5px]',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
)
export function Button({ className, variant, size, ...props }:
  ComponentProps<'button'> & VariantProps<typeof buttonVariants>) {
  return <button className={cn(buttonVariants({ variant, size }), className)} {...props} />
}

/* ---------- Field : label + contrôle ---------- */
export function Field({ label, hint, children }: { label: ReactNode; hint?: string; children: ReactNode }) {
  return (
    <div className="mt-2">
      <label className="block text-[12px] text-muted font-semibold mb-1">{label}</label>
      {children}
      {hint && <div className="text-[12px] text-faint mt-1">{hint}</div>}
    </div>
  )
}

/* ---------- Select ---------- */
export function Select({ className, ...props }: ComponentProps<'select'>) {
  return (
    <select
      className={cn(
        'w-full bg-bg border border-border text-text rounded-ctl px-2 py-2 text-[12.5px]',
        'focus:outline-none focus:border-accent-dim focus:ring-2 focus:ring-accent/15',
        className,
      )}
      {...props}
    />
  )
}

/* ---------- Textarea ---------- */
export function Textarea({ className, ...props }: ComponentProps<'textarea'>) {
  return (
    <textarea
      className={cn(
        'w-full bg-surface2 border border-border text-text rounded-ctl px-2 py-2 text-[12.5px] min-h-[52px] resize-y',
        'focus:outline-none focus:border-accent-dim focus:ring-2 focus:ring-accent/15',
        className,
      )}
      {...props}
    />
  )
}

/* ---------- Segmented : choix exclusifs, couches audio ---------- */
export interface SegmentedOption<T extends string> { value: T; label: string; dotClass?: string }
export function Segmented<T extends string>({ options, value, onChange }: {
  options: SegmentedOption<T>[]; value: T | null; onChange: (v: T) => void
}) {
  return (
    <div className="flex bg-surface2 border border-border rounded-ctl p-[3px] gap-[3px]">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={cn(
            'flex-1 flex items-center justify-center gap-1.5 py-1.5 rounded text-[12px] font-semibold cursor-pointer',
            value === o.value ? 'bg-surface3 text-text' : 'text-muted hover:text-text',
          )}
        >
          {o.dotClass && <span className={cn('w-[7px] h-[7px] rounded-full', o.dotClass)} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/* ---------- Accordion ---------- */
export function Accordion({ title, summary, defaultOpen = false, children, contrib, badge, tone, lock, onToggleLock }: {
  title: string; summary?: string; defaultOpen?: boolean; children: ReactNode
  /** Ce que la section écrit dans le prompt (« 1er — tête du prompt »). */
  contrib?: string
  /** Badge d'état (INERTE, TRAÇABILITÉ…). */
  badge?: string
  /** 'amber' encadre la carte en ambre (ce qui n'agit pas). */
  tone?: 'amber'
  /** Verrou de carrousel : true = fermé (valeur fixe), false = ouvert (varie
   *  par image). Non fourni ⇒ pas de verrou affiché. */
  lock?: boolean
  onToggleLock?: () => void
}) {
  const [open, setOpen] = useState(defaultOpen)
  // `overflow-hidden` seulement fermé : ouvert, il rognerait le menu
  // déroulant du Combobox, qui déborde sous le champ.
  return (
    <div className={cn('border rounded-ctl mb-2',
      tone === 'amber' ? 'border-[#3d3018] bg-[#12100b]' : open ? 'border-border2 bg-surface2' : 'border-border bg-surface2',
      !open && 'overflow-hidden')}>
      {/* Rangée en-tête : verrou (bouton distinct) + zone repliable.
          Deux boutons FRÈRES, jamais imbriqués. */}
      <div className="flex items-stretch">
        {onToggleLock && (
          <button onClick={onToggleLock} type="button"
            title={lock ? t('verrou fermé — valeur fixe pour tout le lot') : t('verrou ouvert — varie à chaque image (carrousel)')}
            className={cn('w-9 shrink-0 flex items-center justify-center border-r text-[13px] cursor-pointer',
              lock ? 'bg-danger/15 border-danger/30 text-danger' : 'bg-[#a78bfa]/10 border-[#a78bfa]/30 text-[#a78bfa]')}>
            {lock ? '🔒' : '🔓'}
          </button>
        )}
        <button
          onClick={() => setOpen(o => !o)}
          className="flex-1 min-w-0 flex flex-col gap-[2px] px-3 py-2 min-h-[44px] cursor-pointer text-left"
        >
          <span className="flex items-center justify-between gap-2 min-w-0">
            <span className="font-semibold text-[12.5px] flex items-center gap-1.5 min-w-0">
              <span className={cn('text-faint text-[12px] inline-block transition-transform', open && 'rotate-90')}>›</span>
              <span className="truncate">{title}</span>
              {badge && <span className="text-[12px] font-mono tracking-[.06em] text-warn bg-[#2b241155] border border-[#3d3018] rounded px-1.5 py-[1px] shrink-0">{badge}</span>}
            </span>
            <span className="text-muted text-[12px] font-mono truncate max-w-[160px] shrink-0">{summary}</span>
          </span>
          {contrib && <span className="block text-[12px] text-faint font-mono pl-4 leading-snug truncate">{contrib}</span>}
        </button>
      </div>
      {open && <div className="px-3 pb-3">{children}</div>}
    </div>
  )
}

/* ---------- Combobox : autocomplete (tenues, environnements…) ---------- */
export interface ComboItem { id: string; label: string; tags: string[] }
export function Combobox({ items, onPick, placeholder, selectedId }: {
  items: ComboItem[]
  onPick: (id: string) => void
  placeholder?: string
  /** Item courant — coché dans la liste. Sans lui, un menu de 40 entrées
   *  n'indique pas ce qui est déjà sélectionné. */
  selectedId?: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Filtre par nom OU par tag (« robe » / « vert »). Requête vide = tout,
  // c'est ce qui fait du champ un vrai menu déroulant et pas seulement
  // une recherche.
  const needle = q.trim().toLowerCase()
  const filtered = needle
    ? items.filter(i =>
        i.label.toLowerCase().includes(needle) ||
        i.tags.some(t => t.toLowerCase().includes(needle)))
    : items

  // Fermer sur clic extérieur : sans ça le menu reste ouvert derrière le
  // reste de la colonne et masque les champs suivants.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!box.current?.contains(e.target as Node)) { setOpen(false); setQ('') }
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  // Garder l'item actif visible quand on navigue au clavier.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="1"]')
      ?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const commit = (id: string) => { onPick(id); setQ(''); setOpen(false) }

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { setOpen(false); setQ(''); return }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      const d = e.key === 'ArrowDown' ? 1 : -1
      setActive(a => (a + d + filtered.length) % Math.max(filtered.length, 1))
      return
    }
    if (e.key === 'Enter' && open && filtered[active]) {
      e.preventDefault()
      commit(filtered[active].id)
    }
  }

  return (
    <div className="relative" ref={box}>
      <span className="absolute left-2.5 top-2 text-faint text-[12px]">⌕</span>
      <input
        value={q}
        onChange={e => { setQ(e.target.value); setActive(0); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={onKey}
        placeholder={placeholder ?? t('Rechercher…')}
        role="combobox" aria-expanded={open}
        className="w-full bg-bg border border-border text-text rounded-ctl pl-7 pr-7 py-2 text-[12.5px] focus:outline-none focus:border-accent-dim focus:ring-2 focus:ring-accent/15"
      />
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-label={open ? t('Fermer la liste') : t('Ouvrir la liste')}
        className="absolute right-1 top-1 px-1.5 py-1 text-faint text-[12px] cursor-pointer hover:text-text">
        <span className={cn('inline-block transition-transform', open && 'rotate-180')}>▾</span>
      </button>

      {open && (
        <div ref={listRef}
          className="absolute left-0 right-0 top-full z-30 mt-1 border border-border rounded-ctl bg-bg shadow-lg max-h-56 overflow-y-auto scroll-clean">
          {filtered.length === 0 && (
            <div className="px-2.5 py-2 text-[12px] text-faint">{t('Aucun résultat')}</div>
          )}
          {filtered.map((i, n) => (
            <button
              key={i.id}
              data-active={n === active ? '1' : '0'}
              onMouseEnter={() => setActive(n)}
              onClick={() => commit(i.id)}
              className={cn(
                'w-full flex justify-between items-center gap-2 px-2.5 py-1.5 text-[12px] text-left cursor-pointer',
                n === active && 'bg-surface3',
                i.id === selectedId && 'text-accent',
              )}
            >
              <span className="truncate">
                {i.id === selectedId && '✓ '}{i.label}
              </span>
              <span className="flex gap-1 shrink-0">
                {i.tags.slice(0, 2).map(tg => (
                  <span key={tg} className="text-[12px] rounded px-1 bg-surface3 border border-border text-muted">{t(tg)}</span>
                ))}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

/* ---------- Slider ligne (label + range + valeur) ---------- */
export function SliderRow({ label, valueLabel, min, max, step, value, onChange }: {
  label: string; valueLabel: string; min: number; max: number; step: number
  value: number; onChange: (v: number) => void
}) {
  return (
    <div className="flex items-center gap-2.5 mt-2.5">
      <span className="text-[12px] text-muted whitespace-nowrap">{label}</span>
      <input
        type="range" className="slider flex-1"
        min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      <span className="text-[12px] text-text whitespace-nowrap">{valueLabel}</span>
    </div>
  )}

/* ---------- Upload (image ou vidéo) ----------
   Zone cliquable → sélecteur de fichier natif (fonctionne aussi
   depuis iPhone/iPad : pellicule/caméra). En POC le fichier vit en
   object-URL côté navigateur ; le worker réel recevra l'upload. */
export function UploadBox({ accept, uri, name, onPick, onFile, hint }: {
  accept: string                        // ex. "image/*" | "video/*"
  uri: string; name: string
  onPick: (uri: string, name: string) => void
  /** Fichier BRUT, pour les usages qui exigent un dépôt réel côté serveur
   *  (une URL d'objet n'existe que dans l'onglet du navigateur). Optionnel :
   *  les zones purement décoratives n'en ont pas besoin. */
  onFile?: (f: File) => void
  hint?: string
}) {
  const isImage = accept.startsWith('image')
  return (
    <label className={cn(
      'block rounded-ctl border-[1.5px] border-dashed cursor-pointer overflow-hidden relative',
      uri ? 'border-accent-dim bg-surface2' : 'border-border2 bg-surface2 hover:border-accent-dim',
    )}>
      <input
        type="file" accept={accept} className="hidden"
        onChange={e => {
          const f = e.target.files?.[0]
          if (f) { onPick(URL.createObjectURL(f), f.name); onFile?.(f) }
          e.target.value = ''
        }}
      />
      {uri ? (
        isImage ? (
          <div className="flex items-center gap-2.5 p-2">
            <img src={uri} alt={name} className="w-14 h-14 object-cover rounded" />
            <div className="min-w-0">
              <div className="text-[12px] text-text truncate">{name}</div>
              <div className="text-[12px] text-accent">{t('changer le fichier')}</div>
            </div>
          </div>
        ) : (
          <div className="flex items-center gap-2.5 p-2">
            <video src={uri} poster={`/api/poster/${encodeURIComponent(uri.split('/').pop() ?? '')}`} preload="none" muted playsInline className="w-14 h-14 object-cover rounded bg-black" />
            <div className="min-w-0">
              <div className="text-[12px] text-text truncate">{name}</div>
              <div className="text-[12px] text-accent">{t('changer le fichier')}</div>
            </div>
          </div>
        )
      ) : (
        <div className="py-5 text-center">
          <div className="text-[18px] text-faint leading-none mb-1">⇪</div>
          <div className="text-[12px] text-muted">
            {isImage ? t('Cliquer pour uploader une image') : t('Cliquer pour uploader une vidéo')}
          </div>
          {hint && <div className="text-[12px] text-faint mt-0.5">{hint}</div>}
        </div>
      )}
    </label>
  )
}

/* ---------- Zoom au survol (poses & vignettes) ----------
   Overlay fixe qui suit la souris — pointer-events none pour ne pas
   gêner le clic. Rendu null tant que rien n'est survolé. */
export function ZoomPreview({ zoom }: {
  zoom: { src: string; label?: string; x: number; y: number } | null
}) {
  if (!zoom) return null
  const W = 340, H = 460
  const x = Math.min(zoom.x + 18, window.innerWidth - W - 12)
  const y = Math.max(8, Math.min(zoom.y - H / 2, window.innerHeight - H - 12))
  return (
    <div className="fixed z-50 pointer-events-none rounded-card border border-border2 bg-[#0d1218] shadow-2xl overflow-hidden"
      style={{ left: x, top: y, width: W }}>
      <img src={zoom.src} alt="" className="w-full object-contain bg-[#10151c]" style={{ maxHeight: H - 28 }} />
      {zoom.label && (
        <div className="px-2 py-1 text-[12px] text-muted border-t border-border truncate">{zoom.label}</div>
      )}
    </div>
  )
}
