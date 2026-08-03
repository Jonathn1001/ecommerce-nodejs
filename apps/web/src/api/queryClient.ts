import { QueryClient } from "@tanstack/react-query";
import { NetworkError } from "./errors";

// React Query retries 3x on EVERY error by default. Left alone that contradicts the error
// taxonomy outright: a SchemaMismatchError is a bug that must surface at once, and a 404 is
// for a product that will never exist. Retry network failures only.
export const makeQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => error instanceof NetworkError && failureCount < 2,
        staleTime: 30_000,
      },
    },
  });
