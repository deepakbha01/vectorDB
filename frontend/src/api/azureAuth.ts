import { AccountInfo, BrowserCacheLocation, InteractionRequiredAuthError, PublicClientApplication } from '@azure/msal-browser';
import { apiClient, extractErrorMessage } from './client';

/**
 * Azure sign-in for the Azure Builder's live mode (Wave 6, spec 9.1). Separate
 * from the Evectorize login: the user signs in to their Azure tenant with MSAL
 * (authorization code + PKCE, no client secret) and the browser asks for a
 * delegated ARM token, which goes to the backend in the X-Azure-Token header
 * of the live calls only. Tokens stay in sessionStorage - gone when the tab closes.
 */

export interface LiveAzureConfig {
  enabled: boolean;
  clientId: string | null;
  tenantId: string | null;
  scopes: string[];
}

/** The page MSAL returns to; must be registered as an SPA redirect URI on the app registration. */
export const AZURE_CALLBACK_PATH = '/azure-builder/callback';
const RETURN_KEY = 'azureBuilder.returnTo';

let configPromise: Promise<LiveAzureConfig> | null = null;
let msalPromise: Promise<PublicClientApplication | null> | null = null;

export function liveAzureConfig(): Promise<LiveAzureConfig> {
  configPromise ??= apiClient
    .get<LiveAzureConfig>('/azure-builder/live-config')
    .then((r) => r.data)
    .catch(() => ({ enabled: false, clientId: null, tenantId: null, scopes: [] }));
  return configPromise;
}

async function msal(): Promise<PublicClientApplication | null> {
  msalPromise ??= liveAzureConfig().then(async (config) => {
    if (!config.enabled || !config.clientId || !config.tenantId) return null;
    // MSAL needs Web Crypto, which browsers only offer on https or localhost - fail with the reason, not a crypto error.
    const insecure = insecureOriginMessage();
    if (insecure) throw new Error(insecure);
    const app = new PublicClientApplication({
      auth: {
        clientId: config.clientId,
        authority: `https://login.microsoftonline.com/${config.tenantId}`,
        redirectUri: `${window.location.origin}${AZURE_CALLBACK_PATH}`,
        postLogoutRedirectUri: null,
      },
      cache: { cacheLocation: BrowserCacheLocation.SessionStorage },
    });
    await app.initialize();
    // Outside the callback page, settle a sign-in left half-way (tab closed, Back pressed); otherwise MSAL keeps an
    // "interaction in progress" flag in this tab and refuses to start the next sign-in.
    if (window.location.pathname !== AZURE_CALLBACK_PATH) await app.handleRedirectPromise().catch(() => null);
    return app;
  });
  return msalPromise;
}

/** Why Azure sign-in cannot work at this address, or null. Entra ID also accepts plain-http redirect URIs only for localhost. */
export function insecureOriginMessage(): string | null {
  if (window.isSecureContext && window.crypto?.subtle) return null;
  const local = `http://localhost${window.location.port ? `:${window.location.port}` : ''}`;
  return `Azure sign-in needs a secure address, and ${window.location.origin} is not one. Open ${local} on this server (or through an SSH tunnel), or serve the app over https.`;
}

/** A readable message for a failed Azure sign-in step: the API's message, or the browser/MSAL error itself - not just the fallback. */
export function azureErrorText(err: unknown, fallback: string): string {
  if (err && typeof err === 'object' && 'response' in err) return extractErrorMessage(err, fallback);
  if (err instanceof Error && err.message) return `${fallback.replace(/\.$/, '')}: ${err.message}`;
  return fallback;
}

/** The signed-in Azure account, if any. */
export async function azureAccount(): Promise<AccountInfo | null> {
  const app = await msal();
  if (!app) return null;
  return app.getActiveAccount() ?? app.getAllAccounts()[0] ?? null;
}

/** Sends the browser to the Microsoft sign-in page; it comes back to `returnTo` via the callback page. */
export async function signInToAzure(returnTo = window.location.pathname): Promise<void> {
  const app = await msal();
  const config = await liveAzureConfig();
  if (!app) throw new Error('Live Azure is not configured on this server.');
  sessionStorage.setItem(RETURN_KEY, returnTo);
  await app.loginRedirect({ scopes: config.scopes, prompt: 'select_account' });
}

/** Completes the sign-in on the callback page; returns where to go next. */
export async function completeAzureSignIn(): Promise<string> {
  const app = await msal();
  if (!app) throw new Error('Live Azure is not configured on this server.');
  const result = await app.handleRedirectPromise();
  if (result?.account) app.setActiveAccount(result.account);
  const returnTo = sessionStorage.getItem(RETURN_KEY) || '/dashboard';
  sessionStorage.removeItem(RETURN_KEY);
  // Only ever return inside this app.
  return returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/dashboard';
}

/** Forgets the Azure sign-in in this browser tab (the Evectorize login is untouched). */
export async function signOutOfAzure(): Promise<void> {
  const app = await msal();
  if (!app) return;
  await app.clearCache();
  app.setActiveAccount(null);
}

/** A delegated ARM token for the signed-in account; null when the user must sign in (again). */
export async function armToken(): Promise<string | null> {
  const app = await msal();
  const config = await liveAzureConfig();
  const account = await azureAccount();
  if (!app || !account) return null;
  try {
    return (await app.acquireTokenSilent({ scopes: config.scopes, account })).accessToken;
  } catch (err) {
    if (err instanceof InteractionRequiredAuthError) return null;
    throw err;
  }
}

/** Headers for a live call; throws a readable error when there is no Azure sign-in. */
export async function armHeaders(): Promise<Record<string, string>> {
  const token = await armToken();
  if (!token) throw new AzureSignInRequired();
  return { 'X-Azure-Token': token };
}

export class AzureSignInRequired extends Error {
  constructor() {
    super('Sign in to Azure first (or again - the sign-in has expired).');
  }
}
