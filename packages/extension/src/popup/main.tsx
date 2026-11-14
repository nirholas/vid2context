import '../styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyTheme } from '../ui/theme.ts';
import { Popup } from './Popup.tsx';

applyTheme();
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Popup />
    </StrictMode>,
  );
}
