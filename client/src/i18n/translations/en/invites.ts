/** The invite accept page (/:lng/invites/:token). */
export const invites = {
  title: 'Join a workspace',
  lead: 'You were invited to a workspace on {{appName}}.',
  signedInAs: 'You’re signed in as {{email}}. The invite must be for this address.',
  accept: 'Accept invite',
  accepting: 'Joining…',
  joined: 'You joined {{workspace}}',
  useAnotherAccount: 'Sign in with another account',
  goToDashboard: 'Go to your dashboard',
  tryAgain: 'Try again',
  errors: {
    wrongEmailTitle: 'This invite is for another email address',
    wrongEmailBody:
      'You’re signed in as {{email}}. Sign out, then sign in with the address the invite was sent to.',
    expiredTitle: 'This invite link no longer works',
    expiredBody:
      'It expired, or the owner withdrew it or sent a newer one. Ask them for a new invite.',
    usedTitle: 'This invite has already been used',
    usedBody: 'If you accepted it before, the workspace is already in your list.',
    alreadyMemberTitle: 'You’re already in this workspace',
    alreadyMemberBody: 'It’s in your list of workspaces already.',
    workspaceFullTitle: 'This workspace is full',
    workspaceFullBody:
      'It has {{membersPerWorkspace}} members already. Ask the owner to make room, then open the link again.',
    unknownTitle: 'The invite couldn’t be accepted',
    unknownBody: 'Check your connection, then try again.',
  },
  join: {
    title: 'Join a workspace',
    lead: 'You opened a join link to a workspace on {{appName}}.',
    signedInAs: 'You’re signed in as {{email}}. Any account can use this link.',
    accept: 'Join workspace',
    errors: {
      goneTitle: 'This join link no longer works',
      goneBody: 'The owner reset it or turned it off. Ask them for the current link.',
      alreadyMemberTitle: 'You’re already in this workspace',
      alreadyMemberBody: 'It’s in your list of workspaces already.',
      workspaceFullTitle: 'This workspace is full',
      workspaceFullBody:
        'It has {{membersPerWorkspace}} members already. Ask the owner to make room, then open the link again.',
      unknownTitle: 'You couldn’t join',
      unknownBody: 'Check your connection, then try again.',
    },
  },
};
