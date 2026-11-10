/**
 * Cifrado del sobre donde viven los tokens de Garmin.
 *
 * La clave NO se guarda en la base de datos: se deriva de SESSION_SECRET con
 * HKDF, que es un secreto del Worker. Quien consiga leer D1 —una copia, un
 * volcado, un permiso mal puesto— se lleva ruido, no la cuenta de nadie.
 *
 * Se deriva en vez de reutilizar SESSION_SECRET tal cual para que la clave que
 * cifra tokens y la que firma cookies no sean el mismo material: eso es lo que
 * hace el `info` de abajo, separar los dos usos. Rotar SESSION_SECRET invalida
 * el sobre, y entonces hay que volver a enlazar la cuenta — que es exactamente
 * lo que debe pasar, no un descuido.
 */

const INFO = "garmin-token-v1";
const IV_BYTES = 12;

export class CriptoError extends Error {}

const cache = new Map<string, Promise<CryptoKey>>();

/** HKDF-SHA256 sobre SESSION_SECRET → clave AES-GCM de 256 bits. */
function clave(secreto: string): Promise<CryptoKey> {
  const guardada = cache.get(secreto);
  if (guardada) return guardada;
  const derivada = (async () => {
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secreto),
      "HKDF",
      false,
      ["deriveKey"],
    );
    return crypto.subtle.deriveKey(
      {
        name: "HKDF",
        hash: "SHA-256",
        // Sin sal: el secreto ya es aleatorio y de longitud completa, y una sal
        // fija guardada al lado no añadiría nada que un atacante no tuviera.
        salt: new Uint8Array(0),
        info: new TextEncoder().encode(INFO),
      },
      material,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"],
    );
  })();
  cache.set(secreto, derivada);
  return derivada;
}

function aBase64Url(bytes: Uint8Array): string {
  let binario = "";
  for (const byte of bytes) binario += String.fromCharCode(byte);
  return btoa(binario).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function deBase64Url(texto: string): Uint8Array {
  const normal = texto.replaceAll("-", "+").replaceAll("_", "/");
  const binario = atob(normal.padEnd(Math.ceil(normal.length / 4) * 4, "="));
  return Uint8Array.from(binario, (c) => c.charCodeAt(0));
}

/** Texto → sobre sellado (base64url de iv‖ciphertext). */
export async function sellar(secreto: string, texto: string): Promise<string> {
  if (!secreto) throw new CriptoError("Falta SESSION_SECRET: sin él no se puede cifrar el token.");
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const cifrado = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      await clave(secreto),
      new TextEncoder().encode(texto),
    ),
  );
  const sobre = new Uint8Array(iv.length + cifrado.length);
  sobre.set(iv, 0);
  sobre.set(cifrado, iv.length);
  return aBase64Url(sobre);
}

/**
 * Sobre sellado → texto. Falla si lo han tocado o si la clave ya no es la misma
 * (SESSION_SECRET rotado): AES-GCM está autenticado, así que un sobre alterado
 * no se descifra a medias, no se descifra.
 */
export async function abrir(secreto: string, sobre: string): Promise<string> {
  if (!secreto) throw new CriptoError("Falta SESSION_SECRET: sin él no se puede leer el token.");
  let bytes: Uint8Array;
  try {
    bytes = deBase64Url(sobre);
  } catch {
    throw new CriptoError("El sobre del token no es base64url válido.");
  }
  if (bytes.length <= IV_BYTES) throw new CriptoError("El sobre del token está truncado.");
  try {
    const claro = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      await clave(secreto),
      bytes.slice(IV_BYTES),
    );
    return new TextDecoder().decode(claro);
  } catch {
    throw new CriptoError(
      "No se pudo descifrar el token de Garmin. Si has cambiado SESSION_SECRET, " +
        "vuelve a enlazar la cuenta desde el panel.",
    );
  }
}
