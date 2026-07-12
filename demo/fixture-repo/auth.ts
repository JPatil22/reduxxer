export function hashPassword(password: string): string {
  return `hashed:${password}`;
}

export function login(username: string, password: string): boolean {
  const hashed = hashPassword(password);
  return hashed === getStoredHash(username);
}

export function getStoredHash(username: string): string {
  return `hashed:${username}-secret`;
}

export function logout(sessionId: string): void {
  console.log(`Session ${sessionId} ended`);
}
