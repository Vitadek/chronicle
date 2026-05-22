import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import { migrateLocalStorageKeys } from './lib/localStorageMigration';

// Migrate scribe_* keys to chronicle_* before any component reads them.
migrateLocalStorageKeys();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
