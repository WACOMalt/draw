import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';
import { API_BASE, IS_TAURI } from './config';

mount(App, { target: document.getElementById('app')! });

// The service worker makes the app installable (Chrome, Edge, Firefox for Android).
// Only in production builds: in dev it would cache Vite's modules.
if (import.meta.env.PROD && !IS_TAURI && !API_BASE && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((e) => console.warn('service worker', e));
  });
}
