/** Node scrypt credential rules shared by login and controlled account provisioning. */
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'
import { EducationError } from '@deepseek-ai/dsh-experimental-education-platform'

/**
 * Normalize the username using the existing workbench's rules.
 * @param value - external username value.
 * @returns canonical ASCII username.
 */
export function normalizeUsername(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) throw invalidInput()
  const username = value.normalize('NFKC').trim().toLowerCase()
  if (!/^[a-z0-9][a-z0-9_.-]{2,31}$/.test(username)) throw invalidInput()
  return username
}

/**
 * Validate login passwords without changing spaces or case.
 * @param value - external password value.
 * @returns original bounded password.
 */
export function loginPassword(value: unknown): string {
  if (typeof value !== 'string' || value.length > 200 || value.trim() === '') throw invalidInput()
  return value
}

/**
 * Derive the prototype-compatible 64-byte salted scrypt value.
 * @param password - validated password.
 * @param salt - stored salt, or the fixed dummy salt for a missing account.
 * @returns derived bytes; no credential is logged.
 */
export function derivePassword(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, (error, key) => {
      if (error !== null) reject(new EducationError('identity-unavailable', 'password verification failed', { cause: error }))
      else resolve(key)
    })
  })
}

/**
 * Create credential fields for controlled Host setup; no signup endpoint uses this function.
 * @param password - operator-supplied password, at least twelve characters.
 * @returns private fields accepted by the existing account repository.
 */
export async function createPasswordCredential(password: string): Promise<{ credentialHash: string; credentialSalt: string }> {
  loginPassword(password)
  if (password.length < 12) throw invalidInput()
  const credentialSalt = randomBytes(16).toString('hex')
  const credentialHash = (await derivePassword(password, credentialSalt)).toString('hex')
  return { credentialHash, credentialSalt }
}

/**
 * Compare derived bytes with a validated durable scrypt hash.
 * @param derived - current verification result.
 * @param hash - stored 128-character hexadecimal value.
 * @returns true when all derived bytes match.
 */
export function matchesPassword(derived: Buffer, hash: string): boolean {
  return timingSafeEqual(derived, Buffer.from(hash, 'hex'))
}

function invalidInput(): EducationError {
  return new EducationError('validation-failed', 'username or password input is invalid')
}
