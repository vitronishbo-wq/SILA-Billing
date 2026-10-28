import { SilaBillingApp } from './app';
import { initAutonomousPwaUpdater } from './services/pwaAutoUpdater';
import '../src/index.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  rootEl.setAttribute('data-sila-mounted', '1');
  window.__SILA_BOOTED__ = true;

  const app = new SilaBillingApp(rootEl);
  void app.mount();

  try {
    initAutonomousPwaUpdater({
      canSafelyReload: () => !app.isBusyWithCriticalTask(),
      beforeReload: () => app.flushDraftNow(),
    });
  } catch {
    // Em navegadores legados sem suporte completo a Service Worker, mantém faturação local operacional
  }
}
