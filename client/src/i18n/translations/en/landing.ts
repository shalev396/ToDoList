export const landing = {
  meta: {
    title: 'TodoList: classes, work and deadlines on one clock',
    description:
      'TodoList puts Jira, ClickUp, Linear, Google Calendar and GitHub on one dashboard: what’s on now, what’s next and every deadline this week. Free for students who also work.',
  },
  hero: {
    title: 'Classes, work and deadlines on one clock',
    lead: 'TodoList brings Jira, ClickUp, Linear, Google Calendar and GitHub into one dashboard. See what’s on now, what’s next and everything due this week, without opening five tabs.',
    cta: 'Create your workspace',
    login: 'Log in',
    note: 'Free for everyone. No card needed.',
  },
  demo: {
    today: 'Today',
    now: 'Now',
    next: 'Next',
    until: 'until {{time}}',
    tomorrowAt: 'tomorrow {{time}}',
    nothingNext: 'Nothing else today',
    deadlines: 'Deadlines',
    nextSevenDays: 'Next 7 days',
    legend: 'Sources',
    clockSummary: 'Today on a 24-hour clock, with {{count}} events. It’s {{time}} now. {{status}}',
    statusNow: 'Now: {{title}}, until {{time}}.',
    statusNext: 'Next: {{title}} at {{time}}.',
    statusTomorrow: 'Next: {{title}}, tomorrow at {{time}}.',
    statusNone: 'Nothing else today.',
    eventList: 'Today’s events',
    event: '{{title}}, {{start}} to {{end}}, {{source}}',
  },
  sources: {
    title: 'Reads from the tools your courses and your job already use',
  },
  live: {
    idle: 'Sample data, changing live',
    deadline: '{{source}}: {{title}} added',
    done: '{{source}}: {{title}} done',
    event: '{{source}}: {{title}} added to today',
    moved: '{{source}}: {{title}} moved',
  },
  flow: {
    title: 'Connect, build, share',
    connect: {
      title: 'Connect your sources',
      body: 'Paste a token or a link. Remove it any time.',
    },
    build: {
      title: 'Build your page',
      body: 'Start from a template, then move and resize blocks.',
    },
    share: {
      title: 'Share with classmates',
      body: 'Choose who edits and who only looks.',
    },
  },
  everyone: {
    title: 'Built for everyone',
    body: 'The same blocks fit a light week of classes and a packed one with two jobs, a degree and a side project.',
    switch: 'Choose a week',
    light: {
      label: 'A light student week',
      who: 'Classes, a gym session and a quiz.',
    },
    packed: {
      label: 'A packed week',
      who: 'Two jobs, studies and a side project.',
    },
    summary: 'Events: {{events}}. Sources: {{sources}}. Booked: {{hours}} h.',
  },
  logic: {
    title: 'Logic at every turn',
    body: 'Every block has rules you can edit: what it shows, how it is sorted, what counts as important. Change a rule and the list follows.',
    steps: 'Edit, then Logic, then pick “Only important”: the list keeps what matters.',
    play: 'Play the walkthrough',
    pause: 'Pause the walkthrough',
    description:
      'Walkthrough: select Edit on a block, open the Logic tab, choose Only important, and the to-do list keeps the important items, soonest first.',
    count: '{{shown}} of {{total}}',
    tabs: {
      data: 'Data',
      logic: 'Logic',
    },
    show: 'Show',
    sources: 'Sources',
    all: 'Everything',
    important: 'Only important',
  },
  showcase: {
    title: 'And the rest of your week, handled',
    rail: 'More features',
  },
  templates: {
    college: 'College',
    work: 'Work',
    personal: 'Personal',
  },
  roles: {
    owner: 'Owner',
    editor: 'Editor',
    viewer: 'Viewer',
  },
  scopes: {
    all: 'Everything',
    college: 'College only',
  },
  features: {
    time: {
      title: 'Your day as a clock, your week as a calendar',
      body: 'The clock shows today on a 24-hour ring, with the needle on now. The calendar opens on the week, with each source in its own color.',
    },
    deadlines: {
      title: 'Deadlines from every source',
      body: 'Moodle assignments, Jira tickets, GitHub reviews and Linear issues in one list. The soonest come first, and anything overdue sits on top.',
    },
    sharing: {
      title: 'Share with classmates',
      body: 'Create a workspace and invite people. Editors can change pages, viewers can only look, and you can share just College while Work stays private.',
    },
    agents: {
      title: 'Ask your AI agent',
      body: 'Connect an AI agent through MCP with a key you can revoke any time. It reads your deadlines and pages, and can only do what the key allows.',
    },
    privacy: {
      title: 'Your tokens stay secret',
      body: 'Tokens are encrypted the moment you save them and are never shown again, not even to you. To change one, you replace it.',
    },
  },
  dashboard: {
    edit: 'Edit',
    openTodos: 'Open to-dos',
  },
  week: {
    title: 'This week',
    eventList: 'This week’s events',
    event: '{{title}}, {{day}}, {{hours}}, {{source}}',
    hours: 'from {{start}} to {{end}}',
  },
  sharing: {
    members: 'Members',
    invite: 'Invite',
    access: 'Access',
  },
  agents: {
    you: 'You',
    agent: 'Your AI agent',
    via: 'Read through TodoList’s MCP server',
  },
  privacy: {
    status: 'Connected',
    token: 'Token',
    sealed: 'Saved and encrypted',
    saved: 'It can’t be shown again, not even to you. To change it, you replace it.',
    synced: 'Synced {{when}}',
  },
  closing: {
    title: 'Put your week on one clock',
    body: 'TodoList is free for everyone, with no paid plan, no trial and no card. Create a workspace, connect a first source, and your dashboard is ready.',
    cta: 'Create your workspace',
    pricing: 'See what’s included',
  },
};
