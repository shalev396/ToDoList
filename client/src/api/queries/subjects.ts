import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { matchCounts } from '@/api/services/attributeService';
import { countsByName } from '@/pages/settings/general/subjectsDraft';
import { useDebounced } from '@/features/editor/useDebounced';

export const SUBJECT_COUNT_DEBOUNCE_MS = 400;

export interface SubjectProbe {
  name: string;
  patterns: string[];
}

/**
 * How many items each subject would take, in order, as the names and patterns are typed: the
 * request waits 400 ms after the last keystroke. Counts come back by subject name, never by
 * position, and none show while a new request is out. Idle for no subjects.
 */
export function useSubjectMatchCounts(workspaceId: string | null, subjects: SubjectProbe[]) {
  const settled = useDebounced(JSON.stringify(subjects), SUBJECT_COUNT_DEBOUNCE_MS);
  return useQuery({
    queryKey: [...queryKeys.attributes(workspaceId ?? ''), 'subject-counts', settled],
    enabled: workspaceId !== null && settled !== '[]',
    queryFn: async ({ signal }) => {
      const response = await matchCounts(
        workspaceId ?? '',
        { subjects: JSON.parse(settled) as SubjectProbe[] },
        { signal, suppressErrorToast: true },
      );
      const sent = JSON.parse(settled) as SubjectProbe[];
      return { byName: countsByName(sent, response.data.counts), capped: response.data.capped };
    },
  });
}
