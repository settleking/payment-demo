import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Admin } from './Admin';
import { App } from './App';
import { Guide } from './Guide';
import './styles.css';

const route = window.location.pathname.replace(/\/+$/, '');

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {route === '/admin' ? <Admin /> : route === '/test' ? <Guide /> : <App />}
  </StrictMode>,
);
