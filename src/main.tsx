import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import './index.css';
import './styles/checkers.css';
import { migrateLocalStorageKeys } from './lib/localStorageMigration';
import { hydrateSettingsFromServer } from './lib/settingsSync';

// Migrate scribe_* keys to chronicle_* before any component reads them.
migrateLocalStorageKeys();

// Pull the user's server-stored preferences into localStorage BEFORE React
// renders, so every `useState(() => localStorage.getItem(...))` initializer
// picks them up — this is what keeps settings stable across updates, browser
// evictions, and devices. Resolves fast (one small GET) and falls through to
// local values offline or before login.
void hydrateSettingsFromServer().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthGate>
        <App />
      </AuthGate>
    </StrictMode>,
  );
});
