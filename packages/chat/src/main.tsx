import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/jetbrains-mono/400.css';
import './styles/app.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ChatApp } from './components/ChatApp.tsx';
import { applyTheme, getTheme } from './lib/settings.ts';

applyTheme(getTheme());

const root = document.getElementById('root');
if (!root) throw new Error('vid2context chat: #root is missing from index.html');
createRoot(root).render(
  <StrictMode>
    <ChatApp />
  </StrictMode>,
);
