import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { registerServiceWorker } from './pwa.js';
import './styles/app.css';
import './styles/reader.css';

const container = document.getElementById('root');
if (!container) throw new Error('#root is missing from the document');

registerServiceWorker();

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
