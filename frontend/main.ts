import { SilaBillingApp } from './app';
import { initAutonomousPwaUpdater } from './services/pwaAutoUpdater';
import '../src/index.css';

const rootEl = document.getElementById('root');
if (rootEl) {
  const app = new SilaBillingApp(rootEl);
  void app.mount();

  initAutonomousPwaUpdater({
    canSafelyReload: () => !app.isBusyWithCriticalTask(),
    beforeReload: () => app.flushDraftNow(),
  });
}
