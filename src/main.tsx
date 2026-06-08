import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AuthGate } from './components/AuthGate.tsx';
import './index.css';
import './styles/checkers.css';
import { migrateLocalStorageKeys } from './lib/localStorageMigration';

// Migrate scribe_* keys to chronicle_* before any component reads them.
migrateLocalStorageKeys();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);
