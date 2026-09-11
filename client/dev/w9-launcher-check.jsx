// Harness entry for scripts/browser-check-video-launcher.mjs (W9).
//
// It mounts the REAL pages/production/ClickupPipeline against the REAL axios client
// (services/api.js, baseURL /api/v1) talking to a REAL http server the check runs.
// Nothing about the page is stubbed: the check decides only what /video-launcher/status
// answers, which is exactly what a store with or without the env would answer.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import ClickupPipeline from '../src/pages/production/ClickupPipeline';
import '../src/index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <div style={{ height: '100vh' }}>
      <ClickupPipeline />
    </div>
  </StrictMode>,
);
