import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import StagePopout from './StagePopout.jsx'

// The pop-out visualizer window (opened via LyricBloom's "pop out" button)
// loads this same page with ?stage=1 and renders just the Stage, synced over
// BroadcastChannel — see StagePopout.jsx.
const isStagePopout = new URLSearchParams(window.location.search).get('stage') === '1'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    {isStagePopout ? <StagePopout /> : <App />}
  </StrictMode>,
)
