/**
 * Autenticación de la web: contraseña única (secreto APP_PASSWORD) y sesión
 * con cookie firmada HMAC-SHA256 (secreto SESSION_SECRET). Sin dependencias.
 */

import { timingSafeEqual } from "../env";

const COOKIE_NAME = "sesion";
const SESSION_DAYS = 60;

function b64url(bytes: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function hmac(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return b64url(signature);
}

export async function createSessionCookie(sessionSecret: string): Promise<string> {
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = String(expires);
  const signature = await hmac(sessionSecret, payload);
  const value = `${payload}.${signature}`;
  return (
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; ` +
    `Max-Age=${SESSION_DAYS * 86_400}`
  );
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function verifySessionCookie(
  cookieHeader: string | null | undefined,
  sessionSecret: string,
): Promise<boolean> {
  if (!cookieHeader) return false;
  const raw = cookieHeader
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE_NAME}=`));
  if (!raw) return false;
  const value = raw.slice(COOKIE_NAME.length + 1);
  const dot = value.lastIndexOf(".");
  if (dot <= 0) return false;
  const payload = value.slice(0, dot);
  const signature = value.slice(dot + 1);
  const expected = await hmac(sessionSecret, payload);
  if (!timingSafeEqual(signature, expected)) return false;
  const expires = parseInt(payload, 10);
  return Number.isFinite(expires) && Date.now() < expires;
}

export async function checkPassword(given: string, expected: string): Promise<boolean> {
  // Pausa pequeña y comparación en tiempo constante: fuerza bruta inviable
  // con una contraseña razonable.
  await new Promise((resolve) => setTimeout(resolve, 250));
  return timingSafeEqual(given, expected);
}
