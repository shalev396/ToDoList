/** Topics: the workspace's pages (H2). Their names are the workspace's own, free text. */
export const topics = {
  /** An item without a topic (none set, or its topic was deleted). */
  unsorted: 'Unsorted',
  all: 'All topics',
  addPage: 'Add page',
  add: {
    title: 'Add a page',
    body: 'A page of its own for a job, a course, a project or anything else. Everyone in {{workspace}} sees it.',
    name: 'Name',
    namePlaceholder: 'e.g. Night job',
    nameRequired: 'Give the page a name.',
    template: 'Start from',
    submit: 'Add page',
    submitting: 'Adding…',
    done: '“{{name}}” was added',
    failed: 'Couldn’t add the page. Try again.',
  },
  templates: {
    none: 'An empty page',
    work: 'Work layout',
    college: 'College layout',
    personal: 'Personal layout',
    dashboard: 'Overview layout',
  },
  cancel: 'Cancel',
  menu: 'Options for {{name}}',
  rename: 'Rename',
  renameLabel: 'New name for {{name}}',
  renamed: 'Renamed to “{{name}}”',
  renameFailed: 'Couldn’t rename the page. Try again.',
  delete: 'Delete',
  deleteTitle: 'Delete “{{name}}”?',
  deleteBody:
    'Its dashboards, views, layout and filters are deleted. Its items stay in the workspace as Unsorted, and so do local to-dos.',
  deleteConfirm: 'Delete page',
  deleted: '“{{name}}” was deleted',
  deleteFailed: 'Couldn’t delete the page. Try again.',
};
