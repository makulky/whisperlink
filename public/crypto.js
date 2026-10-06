// Cifrado de extremo a extremo con la Web Crypto API.
// Funciona igual en el navegador y en Node (para los tests).

export const PBKDF2_ITERATIONS = 600_000;
const INFO = new TextEncoder().encode('whisperlink-v1');
const KEY_BYTES = 32;
const IV_BYTES = 12;
const SALT_BYTES = 16;

export function toB64u(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(str) {
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('base64url inválido');
  let b64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function isValidKey(keyB64u) {
  try {
    return fromB64u(keyB64u).length === KEY_BYTES;
  } catch {
    return false;
  }
}

// Clave AES final = HKDF(urlKey, salt = PBKDF2(contraseña) | vacío).
// Con contraseña hacen falta el enlace Y la contraseña para descifrar.
async function deriveAesKey(urlKey, password, salt) {
  const ikm = await crypto.subtle.importKey('raw', urlKey, 'HKDF', false, ['deriveKey']);
  let hkdfSalt = new Uint8Array(0);
  if (password) {
    const pwKey = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']
    );
    hkdfSalt = new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' }, pwKey, 256
    ));
  }
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: hkdfSalt, info: INFO },
    ikm,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/** Devuelve { key, payload }: key va en el fragmento, payload al servidor. */
export async function encryptSecret(plaintext, password = '') {
  const urlKey = crypto.getRandomValues(new Uint8Array(KEY_BYTES));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const salt = password ? crypto.getRandomValues(new Uint8Array(SALT_BYTES)) : null;
  const aesKey = await deriveAesKey(urlKey, password, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(plaintext)
  ));
  return {
    key: toB64u(urlKey),
    payload: { ciphertext: toB64u(ciphertext), iv: toB64u(iv), salt: salt && toB64u(salt) },
  };
}

/** Lanza un error si la clave o la contraseña no son correctas. */
export async function decryptSecret({ ciphertext, iv, salt }, keyB64u, password = '') {
  const urlKey = fromB64u(keyB64u);
  if (urlKey.length !== KEY_BYTES) throw new Error('Clave inválida');
  const aesKey = await deriveAesKey(urlKey, salt ? password : '', salt && fromB64u(salt));
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64u(iv) }, aesKey, fromB64u(ciphertext)
  );
  return new TextDecoder().decode(plain);
}
