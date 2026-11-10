/* ============================================================
   User additions to vocabularies — persisted in localStorage
   (zustand/persist). The base vocabulary stays read-only;
   additions live separately and are MERGED everywhere (console,
   prompt, vocabularies). Exportable as JSON.
   ============================================================ */
import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { Outfit, Environment, PhotoStyle, Hairstyle, TextPose } from '../types'
import { OUTFITS, ENVIRONMENTS, STYLES, HAIRSTYLES, TEXT_POSES } from '../data/vocabularies'

interface VocabState {
  customOutfits: Outfit[]
  customEnvironments: Environment[]
  customStyles: PhotoStyle[]
  customHairstyles: Hairstyle[]
  customTextPoses: TextPose[]
  addOutfit: (o: Outfit) => void
  addEnvironment: (e: Environment) => void
  addStyle: (s: PhotoStyle) => void
  addHairstyle: (h: Hairstyle) => void
  addTextPose: (p: TextPose) => void
  removeCustom: (kind: string, id: string) => void
  exportJson: () => string
}

export const isCustom = (id: string) => id.startsWith('custom_')
export const newId = () => `custom_${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`

export const useVocabStore = create<VocabState>()(
  persist(
    (set, get) => ({
      customOutfits: [], customEnvironments: [], customStyles: [],
      customHairstyles: [], customTextPoses: [],
      addOutfit: o => set(s => ({ customOutfits: [...s.customOutfits, o] })),
      addEnvironment: e => set(s => ({ customEnvironments: [...s.customEnvironments, e] })),
      addStyle: st => set(s => ({ customStyles: [...s.customStyles, st] })),
      addHairstyle: h => set(s => ({ customHairstyles: [...s.customHairstyles, h] })),
      addTextPose: p => set(s => ({ customTextPoses: [...s.customTextPoses, p] })),
      removeCustom: (kind, id) =>
        set(s => {
          const key = {
            outfit: 'customOutfits', environment: 'customEnvironments', style: 'customStyles',
            hairstyle: 'customHairstyles', textPose: 'customTextPoses',
          }[kind] as keyof VocabState
          return { [key]: (s[key] as { id: string }[]).filter(x => x.id !== id) } as Partial<VocabState>
        }),
      /** Exports the additions as JSON. */
      exportJson: () => {
        const s = get()
        return JSON.stringify({
          outfits: s.customOutfits, environments: s.customEnvironments, styles: s.customStyles,
          hairstyles: s.customHairstyles, textPoses: s.customTextPoses,
        }, null, 2)
      },
    }),
    { name: 'creatoros-vocab-custom' },
  ),
)

/* ---- Base + additions merge (non-React getters, for the
   promptBuilder and the app store) ---- */
export const allOutfits = () => [...OUTFITS, ...useVocabStore.getState().customOutfits]
export const allEnvironments = () => [...ENVIRONMENTS, ...useVocabStore.getState().customEnvironments]
export const allStyles = () => [...STYLES, ...useVocabStore.getState().customStyles]
export const allHairstyles = () => [...HAIRSTYLES, ...useVocabStore.getState().customHairstyles]
export const allTextPoses = () => [...TEXT_POSES, ...useVocabStore.getState().customTextPoses]
