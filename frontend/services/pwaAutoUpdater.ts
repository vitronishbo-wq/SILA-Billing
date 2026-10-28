import { registerSW } from 'virtual:pwa-register';

export interface AutonomousUpdaterHooks {
  /** Retorna true quando não há emissão nem impressão térmica/A4 em curso */
  canSafelyReload: () => boolean;
  /** Grava rascunho atual do terminal em IndexedDB antes de recarregar */
  beforeReload: () => Promise<void>;
}

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutos para terminais POS contínuos
const FOCUS_COOLDOWN_MS = 60 * 1000; // Evita chamadas redundantes em múltiplos eventos de foco
const BUSY_RETRY_MS = 1500; // Aguarda fecho de talão/emissão antes de aplicar o reload

let initialized = false;

export function initAutonomousPwaUpdater(hooks: AutonomousUpdaterHooks): void {
  if (initialized || typeof window === 'undefined' || !('serviceWorker' in navigator)) {
    return;
  }
  initialized = true;

  let isReloading = false;
  let lastCheckAt = 0;
  const hadControllerAtBoot = Boolean(navigator.serviceWorker.controller);

  const scheduleSafeAction = (action: () => Promise<void> | void) => {
    if (isReloading) return;

    const attempt = async () => {
      if (isReloading) return;
      if (!hooks.canSafelyReload()) {
        window.setTimeout(attempt, BUSY_RETRY_MS);
        return;
      }

      isReloading = true;
      try {
        await hooks.beforeReload();
      } catch {
        // Continua com a atualização mesmo se o flush falhar
      }
      await action();
    };

    void attempt();
  };

  const updateSW = registerSW({
    immediate: true,
    onNeedRefresh() {
      scheduleSafeAction(() => updateSW(true));
    },
    onRegisteredSW(_swUrl, registration) {
      if (!registration) return;

      const checkForUpdate = (force = false) => {
        if (!navigator.onLine) return;
        const now = Date.now();
        if (!force && now - lastCheckAt < FOCUS_COOLDOWN_MS) {
          return;
        }
        lastCheckAt = now;
        registration.update().catch(() => {
          // Ignora falhas transitórias de rede em terminais offline
        });
      };

      // Polling ativo a cada 30 minutos para terminais POS ligados continuamente
      window.setInterval(() => {
        checkForUpdate(true);
      }, POLL_INTERVAL_MS);

      // Verificação imediata ao retomar foco, visibilidade ou conectividade
      window.addEventListener('focus', () => checkForUpdate(false));
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          checkForUpdate(false);
        }
      });
      window.addEventListener('online', () => checkForUpdate(true));
    },
  });

  // Quando skipWaiting + clientsClaim ativam um novo Service Worker sobre uma sessão já controlada,
  // garante que o bundle JS/CSS da janela em uso seja atualizado de forma autónoma e segura.
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!hadControllerAtBoot || isReloading) return;
    scheduleSafeAction(() => {
      window.location.reload();
    });
  });
}
