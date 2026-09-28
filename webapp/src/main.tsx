// webapp/src/main.tsx (WP8) — Mini App entry: Telegram boot (ready, expand, theme colors), then React.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { boot } from './lib/tg.ts';
import './styles.css';

boot();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
