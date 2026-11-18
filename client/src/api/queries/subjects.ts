import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { matchCounts } from '@/api/services/attributeService';
import { useDebounced } from '@/features/editor/useDebounced';

export const SUBJECT_COUNT_DEBOUNCE_MS = 400;

export interface SubjectProbe {
  name: string;
  patterns: string[];
}

/**
 * How many items each subject would take, in order, as the names and patterns are typed: the
 * request waits 400 ms after the last keystroke. Idle for no subjects.
 */
export function useSubjectMatchCounts(workspaceId: string | null, subjects: SubjectProbe[]) {
  const settled = useDebounced(JSON.stringify(subjects), SUBJECT_COUNT_DEBOUNCE_MS);
  return useQuery({
    queryKey: [...queryKeys.attributes(workspaceId ?? ''), 'subject-counts', settled],
    enabled: workspaceId !== null && settled !== '[]',
    placeholderData: keepPreviousData,
    queryFn: async ({ signal }) => {
      const response = await matchCounts(
        workspaceId ?? '',
        { subjects: JSON.parse(settled) as SubjectProbe[] },
        { signal, suppressErrorToast: true },
      );
      return response.data;
    },
  });
}
