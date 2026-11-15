/** The consent page for an agent signing in (/:lng/authorize-agent). */
export const agentAuth = {
  title: '{{client}} wants to work in your TodoList',
  returnsTo: 'After you choose, you go back to {{host}}.',
  workspace: 'Workspace',
  name: 'Name',
  nameHint: 'So you can tell your agents apart.',
  access: 'Access',
  roleNote: 'Only what your role allows.',
  allow: 'Allow',
  deny: 'Deny',
  revokeNote: 'You can revoke this anytime in Settings → Agent keys.',
  agentKeysLink: 'Agent keys',
  atCap: 'You have the maximum number of agents here. Revoke one in Agent keys first.',
  expired: 'This sign-in expired. Go back to your agent and connect again.',
  failed: 'That didn’t work. Try again.',
  noWorkspaces: 'You have no workspace yet. Create one in TodoList, then connect again.',
};
