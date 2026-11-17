import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { getRuntime } from '@/api/services/runtimeService';

/**
 * Stage facts (GET /api/public/runtime). They never change while the app runs. If the request
 * fails, callers treat it as "no hint, no demo data", the safe reading on a deployed stage.
 */
export function useRuntime() {
  return useQuery({
    queryKey: queryKeys.runtime,
    staleTime: Infinity,
    retry: false,
    queryFn: async () => {
      const response = await getRuntime({ suppressErrorToast: true });
      return response.data;
    },
  });
}
