// Authentication module using OS keychain via keytar
// Stores JWT in OS keychain for ph auth login/logout

import keytar from 'keytar';

const SERVICE_NAME = 'project-health';
const ACCOUNT_NAME = 'jwt-token';

// Store JWT in OS keychain
export async function storeJWT(token: string): Promise<void> {
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, token);
}

// Retrieve JWT from OS keychain
export async function getJWT(): Promise<string | null> {
  return keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
}

// Remove JWT from OS keychain
export async function removeJWT(): Promise<boolean> {
  return keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
}

// Check if JWT exists in keychain
export async function hasJWT(): Promise<boolean> {
  const token = await getJWT();
  return token !== null;
}

// Auth commands for CLI
export async function authLogin(token: string): Promise<void> {
  if (!token || token.trim() === '') {
    throw new Error('JWT token is required');
  }
  await storeJWT(token);
}

export async function authLogout(): Promise<void> {
  const removed = await removeJWT();
  if (!removed) {
    throw new Error('No JWT found in keychain');
  }
}

export async function authStatus(): Promise<{ loggedIn: boolean; tokenPreview?: string }> {
  const token = await getJWT();
  if (!token) {
    return { loggedIn: false };
  }
  
  // Show preview of token (first 20 chars)
  return {
    loggedIn: true,
    tokenPreview: token.substring(0, 20) + '...',
  };
}

// Get JWT for API requests (used by CLI when making AI calls)
export async function getAuthToken(): Promise<string | null> {
  return getJWT();
}
