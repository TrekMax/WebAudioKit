import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initializeTheme } from './theme'
import './styles.css'

initializeTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Application root element was not found')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
