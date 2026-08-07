import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';

// Set <html data-brand="…"> from the build-time brand env var. Powers the
// [data-brand="puure"] light-theme override in index.css, without touching
// per-component classNames.
const _brand = (import.meta.env.VITE_BRAND_SHORT_NAME || import.meta.env.VITE_BRAND_NAME || '')
  .toString().toLowerCase().trim();
if (_brand) document.documentElement.setAttribute('data-brand', _brand);

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  </StrictMode>
);
