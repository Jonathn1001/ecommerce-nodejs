// The one cookie JavaScript is allowed to read. access_token and refresh_token are httpOnly
// by design; XSRF-TOKEN deliberately is not, because the client has to echo it back in a
// header — that asymmetry is the whole double-submit defence.
export const CSRF_COOKIE = "XSRF-TOKEN";

export function readCsrfToken(): string | null {
  for (const part of document.cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CSRF_COOKIE) return rest.join("=") || null;
  }
  return null;
}
