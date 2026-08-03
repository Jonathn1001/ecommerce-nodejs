import type { ReactNode } from "react";
import { Navigate, useLocation } from "react-router";
import { useSession } from "../hooks/useSession";
import { Skeleton } from "./Skeleton";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { data, isPending } = useSession();
  const location = useLocation();

  if (isPending) return <Skeleton />;
  if (!data?.authenticated)
    // `state.from` is what sends the user back where they were aiming after they sign in.
    return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  return <>{children}</>;
}
