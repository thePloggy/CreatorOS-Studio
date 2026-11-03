import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ecouterErreurs } from './lib/journalBug'
import './index.css'
import App from './App.tsx'
import { brancherCleComfy } from './lib/comfyKey'
import { brancherCleProprietaire } from './lib/proprietaire'
import { installerPersonnage } from './lib/personnage'
import { surveillerMiseAJour } from './lib/miseAJour'
import { suivreLecteurs } from './lib/medias'

brancherCleComfy()
brancherCleProprietaire()
installerPersonnage()
ecouterErreurs()
surveillerMiseAJour()
suivreLecteurs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
