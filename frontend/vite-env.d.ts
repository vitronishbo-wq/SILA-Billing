/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  __SILA_BOOTED__?: boolean;
  __SILA_DEFERRED_PROMPT__?: Event | null;
  __SILA_PWA_INSTALLED__?: boolean;
}
