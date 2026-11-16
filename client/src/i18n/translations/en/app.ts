/** The signed-in app's frame: sidebar, workspace switcher, user menu, mobile bars, shared states. */
export const app = {
  name: '{{appName}}',
  shell: {
    nav: 'Main',
    skipToContent: 'Skip to content',
    search: 'Search',
    dashboard: 'Dashboard',
    integrations: 'Integrations',
    templates: 'Templates',
    settings: 'Settings',
    workspace: 'Workspace',
    collapse: 'Collapse sidebar',
    expand: 'Expand sidebar',
    sections: 'Sections',
    more: 'More',
    noWorkspace: 'No workspace yet',
    createWorkspace: 'Create a workspace',
  },
  workspaceSwitcher: {
    trigger: '{{workspace}}, switch workspace',
    triggerEmpty: 'Workspaces',
    yours: 'Your workspaces',
    create: 'Create workspace',
    join: 'Join with an invite link',
  },
  join: {
    title: 'Join with an invite link',
    description: 'Paste the link from your invite email.',
    label: 'Invite link',
    submit: 'Open invite',
    invalid: 'That isn’t an invite link. Copy the whole link from the email.',
  },
  userMenu: {
    trigger: 'Account: {{name}}',
    profile: 'Profile',
    theme: 'Theme',
    language: 'Language',
    signOut: 'Sign out',
  },
  roles: {
    owner: 'Owner',
    editor: 'Editor',
    viewer: 'Viewer',
  },
  page: {
    loading: 'Loading…',
    loadError: 'Your workspaces couldn’t be loaded.',
    retry: 'Try again',
    close: 'Close',
  },
  topic: {
    missingTitle: 'This page isn’t available',
    missingBody: '{{workspace}} has no page at this address. It may have been deleted.',
    backToDashboard: 'Go to the dashboard',
  },
  integrations: {
    title: 'Integrations',
    emptyTitle: 'Connections are coming here',
    emptyBody:
      'Connect Jira, ClickUp, Linear, Google Calendar and GitHub from this page. Only owners connect sources.',
  },
  templates: {
    title: 'Templates',
    emptyTitle: 'Templates are coming here',
    emptyBody: 'Start a page from a Work, College or Personal layout, or from a blank one.',
  },
  itemLink: {
    title: 'You can’t open this item',
    body: 'It belongs to a workspace you’re not a member of.',
    action: 'Go to the dashboard',
  },
};
