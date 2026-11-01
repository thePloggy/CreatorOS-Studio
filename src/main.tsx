import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ecouterErreurs } from './lib/journalBug'
import './index.css'
import App from './App.tsx'
import { brancherCleComfy } from './lib/comfyKey'
import { brancherCleProprietaire } from './lib/proprietaire'

brancherCleComfy()
brancherCleProprietaire()
ecouterErreurs()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
