import { createRoot } from 'react-dom/client'
import './index.css'
import { App } from './App'
import { boot } from './fog'

createRoot(document.getElementById('root')!).render(<App />)
boot()
