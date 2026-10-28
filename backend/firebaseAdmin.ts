import { applicationDefault, cert, getApps, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

const NAMED_FIRESTORE_DB = 'ai-studio-49352535-85f6-4187-bf2b-3e420dac8a25';

function resolveFirestoreDatabaseId(): string {
  const fromEnv = process.env.FIREBASE_DATABASE_ID?.trim();
  if (fromEnv && fromEnv !== '(default)') {
    return fromEnv;
  }
  return NAMED_FIRESTORE_DB;
}

export const FIRESTORE_DATABASE_ID = resolveFirestoreDatabaseId();

export const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID?.trim() || 'gen-lang-client-0982515821';

export type AdminCredentialSource =
  | 'FIREBASE_SERVICE_ACCOUNT_JSON'
  | 'FIREBASE_CREDENTIALS_BASE64'
  | 'APPLICATION_DEFAULT_OR_PROJECT_ID';

interface RawServiceAccount {
  project_id?: string;
  projectId?: string;
  client_email?: string;
  clientEmail?: string;
  private_key?: string;
  privateKey?: string;
}

function parseJsonResilient(rawInput: string): RawServiceAccount {
  let candidate = rawInput.trim();

  // Remove aspas envolventes acidentais ('...' ou "...")
  if (
    (candidate.startsWith("'") && candidate.endsWith("'")) ||
    (candidate.startsWith('"') && candidate.endsWith('"'))
  ) {
    candidate = candidate.slice(1, -1).trim();
  }

  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === 'string') {
      return JSON.parse(parsed) as RawServiceAccount;
    }
    return parsed as RawServiceAccount;
  } catch {
    // Suporta JSON colado com aspas escapadas (ex: {\"type\": \"service_account\", ...})
    const unescapedQuotes = candidate.replace(/\\"/g, '"');
    return JSON.parse(unescapedQuotes) as RawServiceAccount;
  }
}

function normalizeServiceAccount(raw: RawServiceAccount): ServiceAccount {
  const projectId = raw.project_id || raw.projectId || FIREBASE_PROJECT_ID;
  const clientEmail = raw.client_email || raw.clientEmail;
  const rawKey = raw.private_key || raw.privateKey;

  if (!clientEmail || !rawKey || !rawKey.includes('PRIVATE KEY')) {
    throw new Error(
      'Service Account incompleta ou placeholder: verifique client_email e private_key PEM.'
    );
  }

  // Corrige quebras de linha escapadas (\\n -> \n) comuns em variáveis de ambiente do Render
  const privateKey = rawKey.replace(/\\n/g, '\n');

  return {
    projectId,
    clientEmail,
    privateKey,
  };
}

function parseCredentialFromEnv(): {
  serviceAccount: ServiceAccount | null;
  source: AdminCredentialSource;
  warning: string | null;
} {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonEnv && !jsonEnv.includes('...')) {
    try {
      const parsed = parseJsonResilient(jsonEnv);
      return {
        serviceAccount: normalizeServiceAccount(parsed),
        source: 'FIREBASE_SERVICE_ACCOUNT_JSON',
        warning: null,
      };
    } catch (err) {
      return {
        serviceAccount: null,
        source: 'APPLICATION_DEFAULT_OR_PROJECT_ID',
        warning:
          err instanceof Error
            ? `FIREBASE_SERVICE_ACCOUNT_JSON inválida (${err.message})`
            : 'FIREBASE_SERVICE_ACCOUNT_JSON inválida.',
      };
    }
  }

  const base64Env = process.env.FIREBASE_CREDENTIALS_BASE64?.trim();
  if (base64Env) {
    try {
      const decoded = Buffer.from(base64Env, 'base64').toString('utf-8');
      const parsed = parseJsonResilient(decoded);
      return {
        serviceAccount: normalizeServiceAccount(parsed),
        source: 'FIREBASE_CREDENTIALS_BASE64',
        warning: null,
      };
    } catch (err) {
      return {
        serviceAccount: null,
        source: 'APPLICATION_DEFAULT_OR_PROJECT_ID',
        warning:
          err instanceof Error
            ? `FIREBASE_CREDENTIALS_BASE64 inválida (${err.message})`
            : 'FIREBASE_CREDENTIALS_BASE64 inválida.',
      };
    }
  }

  return {
    serviceAccount: null,
    source: 'APPLICATION_DEFAULT_OR_PROJECT_ID',
    warning: null,
  };
}

let cachedApp: App | null = null;
let cachedDb: Firestore | null = null;
let cachedAuth: Auth | null = null;
let cachedSource: AdminCredentialSource = 'APPLICATION_DEFAULT_OR_PROJECT_ID';
let initError: string | null = null;

export function getFirebaseAdminContext(): {
  app: App | null;
  db: Firestore | null;
  auth: Auth | null;
  credentialSource: AdminCredentialSource;
  databaseId: string;
  projectId: string;
  hasExplicitCredentials: boolean;
  initError: string | null;
} {
  if (!cachedApp) {
    try {
      const existing = getApps();
      if (existing.length > 0) {
        cachedApp = existing[0]!;
      } else {
        const { serviceAccount, source, warning } = parseCredentialFromEnv();
        cachedSource = source;
        initError = warning;

        if (serviceAccount) {
          cachedApp = initializeApp({
            credential: cert(serviceAccount),
            projectId: serviceAccount.projectId || FIREBASE_PROJECT_ID,
          });
        } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
          cachedApp = initializeApp({
            credential: applicationDefault(),
            projectId: FIREBASE_PROJECT_ID,
          });
        } else {
          cachedApp = initializeApp({
            projectId: FIREBASE_PROJECT_ID,
          });
        }
      }

      // Aponta obrigatoriamente para a base de dados Firestore nomeada
      cachedDb = getFirestore(cachedApp, FIRESTORE_DATABASE_ID);
      cachedAuth = getAuth(cachedApp);
    } catch (err) {
      initError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    app: cachedApp,
    db: cachedDb,
    auth: cachedAuth,
    credentialSource: cachedSource,
    databaseId: FIRESTORE_DATABASE_ID,
    projectId: FIREBASE_PROJECT_ID,
    hasExplicitCredentials:
      cachedSource === 'FIREBASE_SERVICE_ACCOUNT_JSON' ||
      cachedSource === 'FIREBASE_CREDENTIALS_BASE64',
    initError,
  };
}
