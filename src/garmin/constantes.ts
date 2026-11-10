/**
 * Los datos de Garmin que no son nuestros: endpoints, identificadores de sus
 * apps y cabeceras que espera. Viven juntos porque cuando Garmin rote algo
 * —y rotará: no hay API pública ni compromiso de estabilidad— el arreglo tiene
 * que ser un sitio, no seis.
 *
 * Adaptado de python-garminconnect (MIT, © 2020-2026 Ron Klinkien) y garth
 * (MIT, © 2020 Matin Tamizi). Ver docs/garmin.md.
 */

export const SSO_ORIGEN = "https://sso.garmin.com";
export const SSO = `${SSO_ORIGEN}/sso`;
/** Ojo: el login de la app móvil NO cuelga de /sso, sino de la raíz. */
export const LOGIN_MOVIL = `${SSO_ORIGEN}/mobile/api/login`;

export const API_ORIGEN = "https://connectapi.garmin.com";
export const DI_TOKEN = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
export const DI_GRANT = `${API_ORIGEN}/di-oauth2-service/oauth/grant/service_ticket`;
export const PERFIL = `${API_ORIGEN}/userprofile-service/socialProfile`;

export const CLIENTE_IOS = "GCM_IOS_DARK";
export const SERVICIO_IOS = "https://mobile.integration.garmin.com/gcm/ios";
export const UA_IOS =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) " +
  "AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

/** Garmin acepta el ticket con varios client_id; se prueban en orden. */
export const CLIENTES_DI = [
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2025Q2",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI_2024Q4",
  "GARMIN_CONNECT_MOBILE_ANDROID_DI",
  "GARMIN_CONNECT_MOBILE_IOS_DI",
];

/** Lo que manda la app de Android. Sin esto, parte de la API contesta con 403. */
export const CABECERAS_NATIVAS: Record<string, string> = {
  "user-agent": "GCM-Android-5.23",
  "x-garmin-user-agent":
    "com.garmin.android.apps.connectmobile/5.23; ; Google/sdk_gphone64_arm64/google; " +
    "Android/33; Dalvik/2.1.0",
  "x-garmin-client-platform": "Android",
  "x-lang": "en",
  "accept-language": "en-US,en;q=0.9",
};

export type Fetcher = typeof fetch;

/**
 * `fetch` sin dueño. En un Worker, llamarlo como método de un objeto
 * (`this.fetcher(...)`) lo rompe con «Illegal invocation»: fetch exige que su
 * `this` sea el global. Envolverlo lo desacopla del objeto que lo guarde.
 */
export const FETCH_GLOBAL: Fetcher = (entrada, init) => fetch(entrada, init);
