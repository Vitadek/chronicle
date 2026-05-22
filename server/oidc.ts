import { Issuer, generators, Client, TokenSet } from 'openid-client';
import { config } from './config';

/**
 * OIDC client wrapper.
 *
 * Uses openid-client's `Issuer.discover()` so any compliant provider works:
 * Keycloak, Authentik, Authelia (with its OIDC provider), Auth0, Google,
 * Okta, Microsoft, GitLab, Nextcloud's OIDC app, etc.
 *
 * Discovery is lazy and cached. If the issuer is briefly unreachable at
 * boot, we don't crash — the first user to try to log in will trigger
 * discovery (and may see an error if it's still down).
 */

let clientPromise: Promise<Client> | null = null;

export async function getOidcClient(): Promise<Client> {
  if (!clientPromise) {
    clientPromise = (async () => {
      const issuer = await Issuer.discover(config.auth.oidc.issuerUrl);

      // Pick token-endpoint auth method:
      //   - explicit override via env wins
      //   - otherwise: 'none' for public clients (no secret), 'client_secret_basic' for confidential
      let authMethod = config.auth.oidc.tokenEndpointAuthMethod;
      if (authMethod === 'auto') {
        authMethod = config.auth.oidc.clientSecret ? 'client_secret_basic' : 'none';
      }

      return new issuer.Client({
        client_id: config.auth.oidc.clientId,
        client_secret: config.auth.oidc.clientSecret || undefined,
        redirect_uris: [config.auth.oidc.redirectUri],
        response_types: ['code'],
        token_endpoint_auth_method: authMethod as any,
      });
    })();

    // Don't memoise failure — let the next request retry discovery.
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

export interface OidcUser {
  sub: string;
  email: string | null;
  displayName: string;
}

/**
 * Build the structured user record we care about, drawing from both the
 * ID token claims and the userinfo endpoint when possible.
 */
export async function extractUser(
  client: Client,
  tokens: TokenSet,
): Promise<OidcUser> {
  const claims = tokens.claims();
  let merged: any = { ...claims };
  if (tokens.access_token) {
    try {
      const ui = await client.userinfo(tokens.access_token);
      merged = { ...merged, ...ui };
    } catch {
      // userinfo is optional; fall back to ID token claims alone
    }
  }
  return {
    sub: String(claims.sub),
    email: merged.email ?? null,
    displayName:
      merged.name ||
      merged.preferred_username ||
      merged.given_name ||
      claims.sub,
  };
}

export { generators };
