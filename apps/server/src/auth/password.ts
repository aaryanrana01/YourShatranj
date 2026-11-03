import argon2 from 'argon2';

/**
 * Argon2id: memory-hard, so guessing passwords on GPUs is slow and costly.
 * Parameters follow OWASP's recommended minimum (19 MiB, 2 iterations).
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

/**
 * A real hash of a random password. Login checks unknown usernames against it,
 * so "no such user" takes as long as "wrong password" and response timing
 * can't reveal which usernames exist.
 */
let dummyHash: Promise<string> | null = null;
export function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(`dummy-${Math.random()}-${Date.now()}`);
  return dummyHash;
}
