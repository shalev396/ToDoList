/**
 * `onMutate` and `onSuccess` for a mutation whose success writes one workspace's cache
 * (`['ws', wid, …]`): the write runs only if no workspace switch happened while the request
 * was in flight. A switch drops that workspace's queries (features/workspaces/switching.ts);
 * a late write would put them back. The dashboard editor checks the generation the same way.
 */
export function sameWorkspace<TData, TVariables>(
  generation: () => number,
  write: (data: TData, variables: TVariables) => void,
) {
  return {
    onMutate: () => ({ generation: generation() }),
    onSuccess: (
      data: TData,
      variables: TVariables,
      started: { generation: number } | undefined,
    ) => {
      if (started?.generation === generation()) {
        write(data, variables);
      }
    },
  };
}
