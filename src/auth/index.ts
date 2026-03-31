// Auth module — no authentication required.
// AI features are freely available to all users.

export async function storeJWT(_token: string): Promise<void> {}

export async function getJWT(): Promise<string | null> {
  return null;
}

export async function removeJWT(): Promise<boolean> {
  return false;
}

export async function hasJWT(): Promise<boolean> {
  return false;
}

export async function authLogin(_token: string): Promise<void> {}

export async function authLogout(): Promise<void> {}

export async function authStatus(): Promise<{
  loggedIn: boolean;
  tokenPreview?: string;
}> {
  return { loggedIn: false };
}

export async function getAuthToken(): Promise<string | null> {
  return null;
}
