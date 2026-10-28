import { initializeApp } from 'firebase/app';
import { GoogleAuthProvider, getAuth, signInWithPopup, signOut } from 'firebase/auth';
import { doc, getDocFromServer, getFirestore } from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);
export const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

let connectionValidated = false;

export async function validateFirestoreConnection(): Promise<void> {
  if (connectionValidated) return;
  connectionValidated = true;
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

export function extractFirebaseErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  const msg = err instanceof Error ? err.message : String(err || '');
  const match = msg.match(/\((auth\/[a-z0-9-]+)\)/i);
  return match ? match[1]!.toLowerCase() : '';
}

export function isUnauthorizedDomainError(err: unknown): boolean {
  const code = extractFirebaseErrorCode(err);
  if (code === 'auth/unauthorized-domain') return true;
  const msg = err instanceof Error ? err.message : String(err || '');
  return msg.toLowerCase().includes('unauthorized-domain') || msg.toLowerCase().includes('not authorized for oauth');
}

export function formatFirebaseAuthErrorPt(err: unknown, autoAuthorized = false): string {
  const host = typeof window !== 'undefined' && window.location?.hostname ? window.location.hostname : 'silabilling.web.app';
  const code = extractFirebaseErrorCode(err);

  if (isUnauthorizedDomainError(err)) {
    if (autoAuthorized) {
      return `O domínio "${host}" acabou de ser autorizado automaticamente no Firebase Authentication pelo servidor. Aguarde cerca de 15 segundos e clique novamente no botão de autenticação.`;
    }
    return `O domínio "${host}" ainda não consta nos domínios OAuth autorizados do Firebase. No Console Firebase (projeto gen-lang-client-0982515821) aceda a Authentication → Settings → Domínios autorizados e adicione "${host}".`;
  }

  if (code === 'auth/popup-blocked') {
    return 'A janela de login Google foi bloqueada pelo navegador. Permita janelas pop-up para este endereço na barra do navegador e clique novamente.';
  }

  if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
    return 'A janela de autenticação Google foi fechada antes de concluir o acesso.';
  }

  if (code === 'auth/network-request-failed') {
    return 'Falha de ligação à rede durante a autenticação Google. Verifique o acesso à internet e tente novamente.';
  }

  return err instanceof Error ? err.message : 'Não foi possível concluir a autenticação Google.';
}

export async function signInWithGoogle() {
  return signInWithPopup(auth, googleProvider);
}

export async function signOutFirebase() {
  return signOut(auth);
}
