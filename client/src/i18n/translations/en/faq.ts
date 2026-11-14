/** Questions shared by the landing and pricing pages; each page picks its own set and order. */
export const faq = {
  title: 'Common questions',
  free: {
    question: 'Is TodoList really free?',
    answer: 'Yes. There’s no paid plan, no trial and no ads.',
  },
  limits: {
    question: 'What are the limits?',
    answer:
      'None on features. Each person can create {{workspacesCreatedPerUser}} workspaces and {{agentKeysPerUser}} agent keys, and connect {{integrationsPerUserPerWorkspace}} accounts of their own in each workspace. Each workspace can have {{membersPerWorkspace}} members and {{integrationsPerWorkspace}} connections in all, each page {{blocksPerPage}} blocks and {{viewsPerPage}} views, and you can sync a connection by hand once every {{manualSyncIntervalMinutes}} minutes. To-dos have no limit.',
  },
  sources: {
    question: 'Which tools can I connect?',
    answer:
      'Jira, ClickUp, Linear, Google Calendar and GitHub, with Moodle coming soon. You can also add to-dos of your own.',
  },
  googleCalendar: {
    question: 'What does TodoList do with my Google Calendar?',
    answer:
      'It reads the calendars you pick and shows their events next to your to-dos. It creates or updates an event only when you set up a push, for the to-dos you choose. Your Google data is never sold, used for ads or used to train AI, and disconnecting revokes TodoList’s access at Google. The privacy policy has the details.',
  },
  sharing: {
    question: 'Can classmates see my work tasks?',
    answer:
      'Only if you share them. You give each member a role, and you can limit what they see to one area, such as College.',
  },
  tokens: {
    question: 'What happens to my tokens?',
    answer:
      'They’re encrypted when you save them and never shown again, not even to you. To change one you replace it, and removing a connection deletes it.',
  },
  agents: {
    question: 'Can I use it with an AI agent?',
    answer:
      'Yes. Create an agent key and connect your agent through MCP. It can only do what the key allows, and you can revoke the key at any time.',
  },
  languages: {
    question: 'Does it work in Hebrew and on my phone?',
    answer: 'Yes. TodoList works in Hebrew and English, on phones and laptops, in light and dark.',
  },
  openSource: {
    question: 'Is it open source?',
    answer: 'Yes, the code is open source.',
    link: 'View the code on GitHub',
  },
  leave: {
    question: 'Can I take my data and leave?',
    answer:
      'Yes. You can export your data or delete your account from your profile whenever you like.',
  },
};
