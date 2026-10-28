import { applicationDefault, cert, getApps, initializeApp, type App, type ServiceAccount } from 'firebase-admin/app';
import { getAuth, type Auth } from 'firebase-admin/auth';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export const FIRESTORE_DATABASE_ID =
  process.env.FIREBASE_DATABASE_ID || 'ai-studio-49352535-85f6-4187-bf2b-3e420dac8a25';

export const FIREBASE_PROJECT_ID =
  process.env.FIREBASE_PROJECT_ID || 'gen-lang-client-0982515821';

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

function normalizeServiceAccount(raw: RawServiceAccount): ServiceAccount {
  const projectId = raw.project_id || raw.projectId || FIREBASE_PROJECT_ID;
  const clientEmail = raw.client_email || raw.clientEmail;
  const rawKey = raw.private_key || raw.privateKey;

  if (!clientEmail || !rawKey) {
    throw new Error(
      'Service Account inválida: campos client_email ou private_key ausentes.'
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
} {
  const jsonEnv = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonEnv) {
    const parsed = JSON.parse(jsonEnv) as RawServiceAccount;
    return {
      serviceAccount: normalizeServiceAccount(parsed),
      source: 'FIREBASE_SERVICE_ACCOUNT_JSON',
    };
  }

  const base64Env = process.env.FIREBASE_CREDENTIALS_BASE64?.trim();
  if (base64Env) {
    const decoded = Buffer.from(base64Env, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded) as RawServiceAccount;
    return {
      serviceAccount: normalizeServiceAccount(parsed),
      source: 'FIREBASE_CREDENTIALS_BASE64',
    };
  }

  return {
    serviceAccount: null,
    source: 'APPLICATION_DEFAULT_OR_PROJECT_ID',
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
  if (!cachedApp && !initError) {
    try {
      const existing = getApps();
      if (existing.length > 0) {
        cachedApp = existing[0]!;
      } else {
        const { serviceAccount, source } = parseCredentialFromEnv();
        cachedSource = source;

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
