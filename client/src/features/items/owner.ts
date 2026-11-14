/** What naming a member needs (a MemberView fits). */
interface NamedMember {
  userId: string;
  name: string | null;
  email: string | null;
}

/**
 * Who added a local to-do, for the item sheet (PERMISSIONS-V2 ruling 6): a current member's name
 * (or email), `former` when they are no longer a member (their to-dos stay, attributed to
 * "Former member"), or null when there is no owner to name (a mirrored item). Pure.
 */
export function ownerOf(
  ownerUserId: string | null,
  members: readonly NamedMember[] | undefined,
): { kind: 'member'; name: string } | { kind: 'former' } | { kind: 'unknown' } | null {
  if (ownerUserId === null) {
    return null;
  }
  if (members === undefined) {
    return { kind: 'unknown' };
  }
  const member = members.find((entry) => entry.userId === ownerUserId);
  if (member === undefined) {
    return { kind: 'former' };
  }
  return { kind: 'member', name: member.name ?? member.email ?? '' };
}
