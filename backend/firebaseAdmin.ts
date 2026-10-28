import crypto from 'node:crypto';
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

  // Se o valor não começar por '{', tenta descodificar automaticamente como Base64
  // (permite colar Base64 diretamente em FIREBASE_SERVICE_ACCOUNT_JSON ou FIREBASE_CREDENTIALS_BASE64)
  if (candidate && !candidate.startsWith('{') && !candidate.startsWith('{\\"')) {
    const cleanB64 = candidate.replace(/\s+/g, '');
    const decoded = Buffer.from(cleanB64, 'base64').toString('utf-8').trim();
    if (decoded.startsWith('{')) {
      candidate = decoded;
    }
  }

  try {
    const parsed = JSON.parse(candidate);
    if (typeof parsed === 'string') {
      return JSON.parse(parsed) as RawServiceAccount;
    }
    return parsed as RawServiceAccount;
  } catch {
    // Suporta JSON colado com aspas escapadas ou quebras de linha literais dentro de strings
    const sanitized = candidate
      .replace(/\\"/g, '"')
      .replace(/"((?:\\.|[^"\\])*)"/gs, (match) =>
        match.replace(/\r/g, '').replace(/\n/g, '\\n').replace(/\t/g, '\\t')
      );
    return JSON.parse(sanitized) as RawServiceAccount;
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

  // Corrige quebras de linha escapadas (\\n -> \n) comuns em variáveis de ambiente do Render/GitHub
  const privateKey = rawKey.replace(/\\n/g, '\n');

  // Validação criptográfica rigorosa da chave RSA PEM antes de inicializar o Admin SDK
  try {
    crypto.createPrivateKey({ key: privateKey, format: 'pem' });
  } catch (err) {
    throw new Error(
      `Chave privada RSA inválida na Service Account (${err instanceof Error ? err.message : String(err)}).`
    );
  }

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
  const jsonOrBase64Env = process.env.FIREBASE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonOrBase64Env && !jsonOrBase64Env.includes('...')) {
    try {
      const parsed = parseJsonResilient(jsonOrBase64Env);
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
  if (base64Env && !base64Env.includes('...')) {
    try {
      const parsed = parseJsonResilient(base64Env);
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
let cachedServiceAccount: ServiceAccount | null = null;
let cachedSource: AdminCredentialSource = 'APPLICATION_DEFAULT_OR_PROJECT_ID';
let initError: string | null = null;
let authDomainsVerified = false;

const REQUIRED_HOSTING_AUTH_DOMAINS = [
  'silabilling.web.app',
  'silabilling.firebaseapp.com',
] as const;

function base64UrlEncode(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

async function mintServiceAccountAccessToken(sa: ServiceAccount): Promise<string> {
  if (!sa.clientEmail || !sa.privateKey) {
    throw new Error('Service Account sem clientEmail/privateKey para emitir token OAuth2.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claimSet = base64UrlEncode(
    JSON.stringify({
      iss: sa.clientEmail,
      sub: sa.clientEmail,
      aud: 'https://oauth2.googleapis.com/token',
      iat: nowSec,
      exp: nowSec + 3300,
      scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/firebase',
    })
  );

  const unsignedJwt = `${header}.${claimSet}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(unsignedJwt);
  signer.end();
  const signature = base64UrlEncode(signer.sign(sa.privateKey));
  const assertion = `${unsignedJwt}.${signature}`;

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }).toString(),
  });

  if (!tokenRes.ok) {
    const errText = await tokenRes.text().catch(() => '');
    throw new Error(`Falha OAuth2 token (${tokenRes.status}): ${errText.slice(0, 180)}`);
  }

  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) {
    throw new Error('Resposta OAuth2 sem access_token.');
  }
  return tokenJson.access_token;
}

/**
 * Garante de forma idempotente que os domínios oficiais do Firebase Hosting secundário
 * (silabilling.web.app e silabilling.firebaseapp.com) constam em authorizedDomains
 * do Firebase Authentication, preservando integralmente todos os domínios já existentes.
 */
export async function ensureFirebaseAuthorizedDomains(): Promise<{
  ok: boolean;
  added: string[];
  alreadyPresent: boolean;
  detail: string;
}> {
  const ctx = getFirebaseAdminContext();
  if (!cachedServiceAccount || !ctx.hasExplicitCredentials) {
    return {
      ok: false,
      added: [],
      alreadyPresent: false,
      detail: 'Service Account explícita não configurada neste ambiente.',
    };
  }

  if (authDomainsVerified) {
    return {
      ok: true,
      added: [],
      alreadyPresent: true,
      detail: 'Domínios OAuth já verificados nesta instância.',
    };
  }

  try {
    const accessToken = await mintServiceAccountAccessToken(cachedServiceAccount);
    const projectId = cachedServiceAccount.projectId || FIREBASE_PROJECT_ID;
    const endpoint = `https://identitytoolkit.googleapis.com/admin/v2/projects/${encodeURIComponent(projectId)}/config`;
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      'X-Goog-User-Project': projectId,
      'Content-Type': 'application/json',
    };

    const getRes = await fetch(endpoint, { method: 'GET', headers });
    if (!getRes.ok) {
      const errBody = await getRes.text().catch(() => '');
      return {
        ok: false,
        added: [],
        alreadyPresent: false,
        detail: `Identity Toolkit GET (${getRes.status}): ${errBody.slice(0, 180)}`,
      };
    }

    const config = (await getRes.json()) as { authorizedDomains?: unknown };
    if (!Array.isArray(config.authorizedDomains) || config.authorizedDomains.length === 0) {
      return {
        ok: false,
        added: [],
        alreadyPresent: false,
        detail: 'Lista authorizedDomains vazia ou indisponível; atualização ignorada por segurança.',
      };
    }

    const existingDomains = config.authorizedDomains.filter(
      (d): d is string => typeof d === 'string' && d.trim().length > 0
    );
    const missing = REQUIRED_HOSTING_AUTH_DOMAINS.filter((d) => !existingDomains.includes(d));

    if (missing.length === 0) {
      authDomainsVerified = true;
      return {
        ok: true,
        added: [],
        alreadyPresent: true,
        detail: 'silabilling.web.app já consta nos domínios autorizados do Firebase Auth.',
      };
    }

    const mergedDomains = Array.from(new Set([...existingDomains, ...missing]));
    const patchRes = await fetch(`${endpoint}?updateMask=authorizedDomains`, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({ authorizedDomains: mergedDomains }),
    });

    if (!patchRes.ok) {
      const patchErr = await patchRes.text().catch(() => '');
      return {
        ok: false,
        added: [],
        alreadyPresent: false,
        detail: `Identity Toolkit PATCH (${patchRes.status}): ${patchErr.slice(0, 180)}`,
      };
    }

    authDomainsVerified = true;
    return {
      ok: true,
      added: [...missing],
      alreadyPresent: false,
      detail: `Domínios adicionados com sucesso ao Firebase Auth: ${missing.join(', ')}`,
    };
  } catch (err) {
    return {
      ok: false,
      added: [],
      alreadyPresent: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

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
      const { serviceAccount, source, warning } = parseCredentialFromEnv();
      cachedServiceAccount = serviceAccount;
      cachedSource = source;
      initError = warning;

      const existing = getApps();
      if (existing.length > 0) {
        cachedApp = existing[0]!;
      } else if (serviceAccount) {
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
