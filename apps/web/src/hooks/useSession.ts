import { useQuery, useQueryClient } from "@tanstack/react-query";
import { probeSession } from "../api/session";

export const SESSION_KEY = ["session"] as const;

export function useSession() {
  return useQuery({ queryKey: SESSION_KEY, queryFn: probeSession });
}

// Every cart mutation and the checkout invalidate this — POST /orders clears the cart inside
// the same transaction that writes the order, so the badge is stale the moment it returns.
export function useInvalidateSession() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SESSION_KEY });
}
