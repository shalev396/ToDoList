/** Failed API calls (api/errors.ts): by the server's machine code, then by HTTP status. */
export const errors = {
  codes: {
    inviteUsed: 'This invite has already been used.',
    alreadyMember: 'This person is already a member of the workspace.',
    workspaceFull:
      'The workspace is full: it can have {{membersPerWorkspace}} members, pending invites included.',
    emailMismatch: 'This invite was sent to a different email address.',
    inviteExpired: 'This invite link no longer works.',
    inviteRateLimited: 'Too many invites for now. Wait a few minutes, then try again.',
    slugTaken: 'That link name is taken. Try another one.',
    workspaceLimit:
      'You already own {{workspacesCreatedPerUser}} workspaces, the most allowed. Delete one to create another.',
    lastOwner: 'A workspace needs its owner. To stop using it, delete the workspace.',
    attributeExists: 'An attribute with this key already exists.',
    attributeLimit:
      'This workspace already has the most attributes allowed. Delete one to add another.',
    attributeBuiltin: 'The built-in attribute can be renamed, not deleted.',
    topicLimit: 'This workspace already has the most pages allowed. Delete one to add another.',
    invalidCredentials: 'Incorrect email or password.',
    emailUnverified: 'Verify your email before you log in.',
    userExists: 'An account with this email already exists. Log in instead.',
    codeInvalid: 'That code isn’t right. Check it and try again.',
    codeExpired: 'That code has expired. Request a new one.',
    passwordPolicy:
      'Use a stronger password: at least 8 characters, with upper- and lowercase letters, a number and a symbol.',
    accountAlreadyConnected:
      'That account is already connected in this workspace. Connect a different one.',
    providerComingSoon: 'This integration is coming soon and can’t be connected yet.',
    integrationReadOnly:
      'This connection is read-only, so nothing is changed in that tool. Its owner can switch it to Read & write.',
    statusNotAvailable:
      'That tool has no way to set this item to that status. Change it there instead.',
    scopeMissing:
      'This connection needs a new permission for that. Connect it again and allow everything it asks for.',
    fieldNotWritable:
      'That tool doesn’t let TodoList change this here. Change it in that tool instead.',
    providerPartialWrite:
      'Only part of the change was made in that tool. Check the item there, then try the rest again.',
    providerItemMissing: 'This item no longer exists in that tool.',
    eventHasGuests: 'This event has other guests. Choose whether to notify them, then try again.',
    providerWritesOff: 'Creating items in your other tools is turned off on this server.',
    createRateLimited: 'You have created a lot of items there this hour. Try again later.',
    needsDueDate: 'A calendar event needs a due date.',
    integrationNotFound:
      'Only your own connections can be added to a block. Ask their owner to add theirs.',
    oauthUnavailable: 'Connecting with Google isn’t set up on this server yet.',
    oauthDenied: 'Google Calendar wasn’t connected: access was declined.',
    oauthStateInvalid:
      'That sign-in link isn’t valid in this browser. Start again from Connect Google Calendar.',
    oauthStateExpired: 'That sign-in took more than 10 minutes. Start again.',
    oauthStateUsed: 'That sign-in link was already used. Start again.',
    oauthScopeMissing:
      'TodoList needs both calendar permissions. Connect again and leave them ticked.',
    oauthNotEditor: 'Only editors and owners can connect their own accounts here.',
    oauthLimit: 'You, or this workspace, have the most connections allowed. Disconnect one first.',
    oauthFailed: 'Google Calendar couldn’t be connected. Try again.',
  },
  generic: 'Something went wrong. Try again in a moment.',
  status: {
    badRequest: 'Something in the form isn’t valid. Check it and try again.',
    forbidden: 'You don’t have permission to do that.',
    notFound: 'That no longer exists.',
    conflict: 'That changed in the meantime. Reload the page and try again.',
    gone: 'That link no longer works.',
    tooLarge: 'That’s too large to send.',
    tooMany: 'Too many attempts. Wait a minute, then try again.',
  },
};
