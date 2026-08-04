import type { Cart } from "@ecom/contracts";
import { authRequest } from "./refresh";
import { getCart } from "./cart";
import { UnauthenticatedError } from "./errors";

export type Session = { authenticated: boolean; cart: Cart | null };

// The session is whatever GET /cart says. The XSRF cookie cannot stand in for this: the
// gateway clears it on logout and on a rejected refresh, but nothing clears it when the
// refresh token merely expires, so the header would claim a session the server forgot.
// A 401 here resolves to "logged out" — it never redirects. Redirecting is the answer to an
// unauthenticated protected route, not to the question "is anyone signed in?".
export async function probeSession(): Promise<Session> {
  try {
    return { authenticated: true, cart: await getCart() };
  } catch (e) {
    if (e instanceof UnauthenticatedError) return { authenticated: false, cart: null };
    throw e;
  }
}

export const login = (email: string, password: string) =>
  authRequest("/auth/login", { email, password });
export const register = (email: string, password: string, name: string) =>
  authRequest("/auth/register", { email, password, name });
export const logout = () => authRequest("/auth/logout");
