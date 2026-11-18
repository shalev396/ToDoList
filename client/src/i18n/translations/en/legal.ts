/**
 * Privacy and Terms in plain language. Each section body may hold several paragraphs separated
 * by a blank line. The review note stays until a lawyer has reviewed the text.
 */
export const legal = {
  reviewNote:
    'This summary is written to be accurate about how TodoList works; have it reviewed by a lawyer before launch.',
  lastUpdated: 'Last updated: {{date}}',
  contents: 'On this page',
  privacy: {
    title: 'Privacy policy',
    metaTitle: 'Privacy policy',
    intro:
      'TodoList shows your classes, work and deadlines in one place. This page explains what it keeps, who can see it and how it is protected, in plain words.',
    sections: {
      summary: {
        title: 'The short version',
        body: 'TodoList keeps your account, your workspaces and copies of the items from the tools you connect. Your connection secrets are encrypted and never shown again. We don’t sell your data and we don’t show ads.',
      },
      accounts: {
        title: 'Your account and workspaces',
        body: 'For your account we keep your email address and your name. Sign-in is handled by our hosting provider’s sign-in service, so we never see your password.\n\nFor your workspaces we keep their names, their members and roles, and the pages and blocks you build. We also keep short service logs with tokens and personal details removed.',
      },
      sources: {
        title: 'Connected sources',
        body: 'When you connect a tool, TodoList reads items from it and keeps a copy so your dashboards can show them. We only read from these tools. The one exception is Google Calendar, described below.\n\nJira: issues your account can see, with titles, statuses, dates and links.\n\nClickUp: tasks and lists, with titles, statuses, due dates and links.\n\nLinear: issues and projects, with titles, statuses, dates and links.\n\nMoodle: your courses, assignments, deadlines and submission status, using a token you create on your school’s Moodle site.\n\nGitHub: repositories, issues, pull requests and Projects boards that your connection can see, read-only.\n\nGoogle Calendar: we read your events. You connect it with Google sign-in (OAuth). TodoList writes to your calendar only when you set up a push, and only the events you choose to push.',
      },
      google: {
        title: 'Google user data',
        body: 'When you connect Google Calendar, Google asks you to let TodoList see your email address, see the list of your calendars, and view and edit the events in them. TodoList uses this only to run the calendar connection for you, nothing else.\n\nYour email address names the connection, so you can tell your Google accounts apart. Your calendar list lets you pick which calendars to sync. TodoList reads the events of the calendars you pick and shows them on your dashboards. It creates or updates an event only when you set up a push, and only for the to-dos you choose to push.\n\nThe access Google gives TodoList is encrypted at rest under a key held in AWS KMS (see below), and the copies of your events are stored like your other items. No person at TodoList reads your Google data, unless you ask us to for support, it is needed for security or the law requires it. We don’t sell it, we don’t use it for ads, and we don’t use it to train AI models. We share it with no one, apart from the hosting providers listed under “Who processes data for us”.\n\nWhen you disconnect Google Calendar, TodoList revokes its access at Google right away, deletes the stored access, and your events leave your dashboards; their copies are purged as described under “How long we keep things”. Deleting your account deletes every connection you own and the access stored with it. You can also remove TodoList’s access at Google at any time, at myaccount.google.com/permissions.',
      },
      googleLimitedUse: {
        title: 'Google API Services User Data Policy',
        body: 'TodoList’s use and transfer to any other app of information received from Google APIs will adhere to the <policy>Google API Services User Data Policy</policy>, including the Limited Use requirements.',
      },
      secrets: {
        title: 'How connection secrets are stored',
        body: 'Tokens and keys you give us are encrypted at rest with AES-256-GCM, under a separate encryption key for each stage of the service held in AWS KMS. Each secret is bound to the workspace and the connection it belongs to, so it can’t be used anywhere else.\n\nSecrets are write-only. After you save one it is never shown again, and it is never sent to your browser or to AI agents. Only the sync and calendar processes can decrypt a secret, and only when they need it.\n\nWhen you disconnect a source, we delete the stored secret, and we revoke it at Google where Google supports that.',
      },
      agents: {
        title: 'AI agents (MCP)',
        body: 'You can create agent keys so an AI assistant can work with your workspace over MCP. We store only a hash of each key. An agent sees only what the key’s scopes and your role in the workspace allow, and it never sees connection tokens. You can revoke a key at any time. An agent can also sign in instead of using a key. For that we store the agent’s name, its redirect address and hashes of its tokens, never the tokens themselves. Sign-ins show in Agent keys, you can revoke them at any time, and they end when you leave the workspace or delete your account.',
      },
      sharing: {
        title: 'Sharing and who can see what',
        body: 'Members of a workspace see that workspace’s mirrored items, within their topic scope: an owner can limit a member to certain topics, and a member then sees only those.\n\nYou bring people in with an email invite or a join link. Anyone who joins can see what their role and scope allow, so share links only with people you trust. Remove a member or revoke a link at any time.',
      },
      travel: {
        title: 'Places and travel time',
        body: 'Travel time is optional. When you turn it on, TodoList keeps the places you save (Home, campus, the gym) with their addresses and coordinates, together with your travel rules and settings.\n\nTo work out how long a trip takes, TodoList sends the coordinates of two of your places to OpenRouteService, a routing service. To find a place from an address you type, or from the location of an event you mark for travel, it sends that address to OpenRouteService’s geocoder or to OpenStreetMap Nominatim. Both are free services, and their own privacy policies cover what they do with a request. Without an OpenRouteService key, trips use the length you entered or a rough estimate from the distance.\n\nYour places, addresses and coordinates are private to you: they are never shared with other members of a workspace, never logged, and never given to AI agents, which see place names only. A travel leg on your calendar carries place names only, and only you can see it. When you leave a workspace, your places, travel rules and travel settings are deleted at once, and so are your legs.',
      },
      retention: {
        title: 'How long we keep things',
        body: 'When you delete an item, it is purged for good after 30 days. When you disconnect a source, its items disappear from view right away and are purged on the same schedule.\n\nWhen you delete your account, we delete the workspaces it owns, with their data and secrets, and remove your memberships in other workspaces.',
      },
      processors: {
        title: 'Who processes data for us',
        body: 'Amazon Web Services hosts the service, holds the encryption keys (KMS) and sends our email (SES).\n\nMongoDB Atlas hosts the database.\n\nThe providers you connect, such as Atlassian, ClickUp, Linear, your school’s Moodle, Google and GitHub, receive the requests we make on your behalf. Their own privacy policies cover what they do with your data.',
      },
      promises: {
        title: 'What we don’t do',
        body: 'We don’t sell your data, we don’t show ads and we don’t use advertising or tracking cookies. Your browser keeps your sign-in session, your language and your theme so the app works between visits.',
      },
      contact: {
        title: 'Contact',
        body: 'Questions about privacy go to <email>{{contactEmail}}</email>.',
      },
    },
  },
  terms: {
    title: 'Terms of service',
    metaTitle: 'Terms of service',
    intro:
      'These terms are the agreement between you and TodoList when you use it. They are short on purpose.',
    sections: {
      summary: {
        title: 'The short version',
        body: 'TodoList is free for individuals. Connect only accounts you’re allowed to use, take care of the workspaces you share, and don’t misuse the service. It is provided as is.',
      },
      free: {
        title: 'Free for individuals',
        body: 'The individual plan is free and has no feature limits. Fair use applies: please don’t overload the service, and expect sensible technical safeguards, such as how often you can sync by hand, that keep it running for everyone.',
      },
      business: {
        title: 'Business and school use',
        body: 'If you want to use TodoList for a company, a school or a larger group, contact us first and we’ll work something out.',
      },
      account: {
        title: 'Your account',
        body: 'You need an account to use TodoList. Keep your sign-in safe and tell us if you think someone else is using it. You’re responsible for what happens in your account.',
      },
      responsibilities: {
        title: 'Connected accounts and shared workspaces',
        body: 'Connect only accounts and tokens you have the right to use, and keep them valid. You’re responsible for what you connect.\n\nWhen you invite people or share a join link, you choose to share that workspace’s data with them. Owners decide who can edit and who can only view, and who sees which topics.',
      },
      thirdParty: {
        title: 'Third-party terms',
        body: 'Jira, ClickUp, Linear, Moodle, Google and GitHub each have their own terms, and they still apply to you. TodoList isn’t responsible for those tools or for what’s in them.',
      },
      warranty: {
        title: 'Provided as is',
        body: 'We work to keep TodoList running and your data safe, but the service is provided as is, without warranties, and may be unavailable at times. As far as the law allows, we aren’t liable for indirect losses, missed deadlines, lost data or downtime. Your items still live in the original tools, so keep anything important there too.',
      },
      openSource: {
        title: 'Open source',
        body: 'TodoList’s code is open source and you can read it <repo>on GitHub</repo>. Its license covers the code; these terms cover your use of the hosted service.',
      },
      ending: {
        title: 'Ending your account',
        body: 'You can delete your account at any time. We may suspend or close an account that breaks these terms or harms the service, or end the service, and we’ll try to give notice first.',
      },
      changes: {
        title: 'Changes to these terms',
        body: 'We may update these terms. If a change matters, we’ll say so in the app before it takes effect. Using TodoList after that means you accept the new terms.',
      },
      contact: {
        title: 'Contact',
        body: 'Questions about these terms go to <email>{{contactEmail}}</email>.',
      },
    },
  },
};
