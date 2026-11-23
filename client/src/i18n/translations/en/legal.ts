/**
 * Privacy and Terms in plain language. Each section body may hold several paragraphs separated by
 * a blank line; a paragraph whose every line starts with "- " is a bulleted list. A link is
 * written as a tag, `<aws>label</aws>`, and LegalDocument's LINKS says where each one points
 * (`email` is the contact address, `authority` Israel's Privacy Protection Authority).
 *
 * Every claim here is checked against the code. When what TodoList does changes, change the text
 * and LAST_UPDATED in LegalDocument.tsx with it, in both languages.
 */
export const legal = {
  lastUpdated: 'Last updated: {{date}}',
  contents: 'On this page',
  privacy: {
    title: 'Privacy policy',
    metaTitle: 'Privacy policy',
    intro:
      'TodoList puts your classes, work and deadlines in one place. This policy explains, in plain words, what TodoList keeps about you, why, who can see it, how long it is kept and what you can ask us to do with it. It covers the TodoList website and app at todolist.shalev396.com and its MCP server for AI agents.',
    sections: {
      summary: {
        title: 'The short version',
        body: '- TodoList keeps your account, your workspaces and copies of the items from the tools you connect, so your dashboards can show them.\n- It writes to a connected tool only after you switch that connection to Read & write, and then only to carry out what you do in TodoList.\n- Your connection secrets are encrypted and never shown again, not even to you.\n- We don’t sell your data, we don’t show ads, we don’t track you across other sites and we don’t use your data to train AI models.\n- You can download your data, correct it or delete your account at any time.',
      },
      whoWeAre: {
        title: 'Who runs TodoList',
        body: 'TodoList is built and run by Shalev Ben Moshe, an independent developer in Israel (“we”, “us”). We decide how and why your personal information is used, so under Israel’s Protection of Privacy Law, 5741-1981, we are the controller of TodoList’s database.\n\nYou can reach us about anything in this policy at <email>{{contactEmail}}</email>.',
      },
      collect: {
        title: 'What we collect',
        body: 'We collect only what TodoList needs to work:\n\n- Your account: your email address, your name and, if you add one, a profile photo. Sign-in runs on Amazon Cognito, the sign-in service of Amazon Web Services. Your password is passed to it over an encrypted connection; TodoList never stores it and never writes it to a log.\n- Your workspaces: their names, members and roles, topics, the pages and blocks you build, your own to-dos and notes, and the invitations you send, with the invitee’s email address.\n- Your connections: copies of the items from the tools you connect (see “Connected sources”), the account name or email address each connection shows, and the encrypted secret that lets TodoList reach the tool.\n- Travel, only if you turn it on: the places, rules and trip times you enter (see “Places and travel time”).\n- AI agents: the name of each agent key or agent sign-in, and hashes of their keys and tokens (see “AI agents (MCP)”).\n- Security records: an activity log of important actions in each workspace (who did what and when, with the IP address and browser of the request), and short service logs in which passwords, tokens and keys are masked.\n\nWe don’t collect your device’s location, your contacts or any payment details, and TodoList runs no analytics or tracking tools.\n\nNo law requires you to give us any of this. Without an email address, though, you can’t create an account, and without connecting a tool, TodoList can’t show its items.',
      },
      use: {
        title: 'How we use it',
        body: 'We use your information only to run TodoList for you:\n\n- to show your items, calendars and deadlines on your dashboards, and keep them in sync with the tools you connect;\n- to carry out what you ask, such as creating a to-do in a connected tool or sending your to-dos to Google Calendar;\n- to send the emails the service needs: sign-up and password-reset codes, workspace invitations, a notice when a workspace you had connections in is deleted, and a test email when you ask for one;\n- to keep the service and your account secure, prevent abuse (for example, by limiting how many requests can come from one address) and fix problems;\n- to answer you when you write to us;\n- to meet our legal obligations.\n\nWe don’t send marketing email, and TodoList itself doesn’t send your data to any AI service. AI agents read your data only when you connect one yourself (see “AI agents (MCP)”).',
      },
      promises: {
        title: 'What we don’t do',
        body: '- We don’t sell or rent your information.\n- We don’t show ads, and we don’t share your information with advertisers or data brokers.\n- We don’t track you across other websites or build profiles of you.\n- We don’t use your information, including your Google data, to train AI models.',
      },
      sources: {
        title: 'Connected sources',
        body: 'When you connect a tool, TodoList reads items from it and keeps a copy so your dashboards can show them. A new connection is always read-only. TodoList writes to a tool only after you switch that connection to Read & write, and then only to carry out what you do in TodoList.\n\nTodoList connects with the provider’s own sign-in (OAuth) or with a token or key you create there, and you can disconnect any tool at any time. When you connect a tool, that provider’s own privacy policy also applies, both to the data it holds and to the requests TodoList makes for you:\n\n- Jira (Atlassian): the issues your account can see, with titles, statuses, dates, priorities and links. With Read & write, the changes you make in TodoList to an issue’s title, status, due date or priority are sent to Jira, and “Also create in” creates a new issue. <atlassian>Atlassian’s privacy policy</atlassian>\n- ClickUp: tasks and lists, with titles, statuses, dates, priorities and links. With Read & write, the changes you make to a task’s name, status, dates or priority are sent to ClickUp, and “Also create in” creates a new task. <clickup>ClickUp’s privacy policy</clickup>\n- Linear: issues and projects, with titles, statuses, dates, priorities and links. With Read & write, the changes you make to an issue’s title, status, due date or priority are sent to Linear, and “Also create in” creates a new issue. <linear>Linear’s privacy policy</linear>\n- GitHub: the repositories, issues, pull requests and Projects boards your connection can see. With Read & write, the changes you make to an issue’s title or open or closed state are sent to GitHub, and “Also create in” creates a new issue. <github>GitHub’s privacy statement</github>\n- Google Calendar: the events of the calendars you pick and, with Read & write, the writes described under “Google user data”. <google>Google’s privacy policy</google>\n- Moodle (coming soon): your courses, assignments, deadlines and submission status, read with a token you create on your school’s Moodle site. Your school’s own privacy policy covers its Moodle site; see also <moodle>Moodle’s privacy notice</moodle>.',
      },
      google: {
        title: 'Google user data',
        body: 'When you connect Google Calendar, you sign in with Google, and Google asks you to let TodoList:\n\n- see your email address;\n- see the list of your calendars;\n- view and edit the events in your calendars;\n- make secondary calendars, and see, create, change and delete events on them (this reaches only the calendars TodoList creates).\n\nTodoList uses this access only to run the calendar connection for you, and for nothing else. Your email address names the connection, so you can tell your Google accounts apart. Your calendar list lets you pick which calendars TodoList reads. TodoList reads the events of the calendars you pick and shows them on your dashboards.\n\nA new connection is read-only. TodoList writes to Google Calendar only after you switch the connection to Read & write, and then only in these cases:\n\n- “Also create in Google Calendar”: it creates an event from a to-do, in the calendar you pick.\n- Repeating to-dos: it creates the repeating event in your workspace calendar.\n- “Sync to Google Calendar”: it sends your dated items to the one workspace calendar you choose (your to-dos, and the items from your other connected tools that have a date, unless you turn an item off), and updates or deletes those same events as the items change. You can choose an existing calendar or let TodoList create a new one.\n- Editing an event in TodoList: when you change a synced event’s title or time, the change is saved in Google Calendar.\n- Cleaning up, when you ask (Remove, Stop sending, or Disconnect with “Also remove everything TodoList added”): it deletes the events TodoList added and the calendars it created.\n\nDisabling an item in TodoList is kept in TodoList only and never changes anything in Google Calendar; a disabled item is left out of what TodoList sends.\n\nThe access Google gives TodoList is encrypted at rest under a key held in AWS KMS (see “How connection secrets are stored”), and the copies of your events are stored like your other items. No person at TodoList reads your Google data, unless you ask us to for support, it is needed for security or the law requires it. We don’t sell it, we don’t use it for ads, and we don’t use it to train AI models.\n\nTodoList shares your Google data only in these ways, all of them in your control:\n\n- with the members of a workspace, when you add the connection to a block they can see (see “Sharing and who can see what”);\n- with the people a Google calendar is shared with, for the events TodoList adds to that calendar;\n- with AI agents you connect over MCP, within the scopes you give them (see “AI agents (MCP)”);\n- with the providers that host TodoList, which process it only on our behalf (see “Sub-processors”).\n\nWhen you disconnect Google Calendar, TodoList revokes its access at Google right away (unless another of your TodoList connections still uses the same Google account), deletes the stored access, and your events leave your dashboards; their copies are deleted as described under “How long we keep things”. Deleting your account deletes every connection you own and the access stored with it. You can also remove TodoList’s access at Google at any time, at <permissions>myaccount.google.com/permissions</permissions>.',
      },
      googleLimitedUse: {
        title: 'Google API Services User Data Policy',
        body: 'TodoList’s use and transfer to any other app of information received from Google APIs will adhere to the <policy>Google API Services User Data Policy</policy>, including the Limited Use requirements.',
      },
      agents: {
        title: 'AI agents (MCP)',
        body: 'You can let an AI assistant work with your workspace over MCP, with an agent key or by letting the agent sign in. An agent sees and does only what its scopes and your role in the workspace allow. Within the scopes you give it, it can read your items, including your Google Calendar events and the items from your other connected tools, and act for you: for example, add or update to-dos, run a sync or send your to-dos to Google Calendar. It never sees connection secrets, and it sees place names only, never addresses.\n\nWe store only a hash of each agent key. For an agent sign-in we store the agent’s name, its redirect address and hashes of its tokens, never the tokens themselves. Keys and sign-ins show under Agent keys. You can revoke them at any time, and they end when you leave the workspace or delete your account.\n\nThe agent itself is run by its own provider, such as the company behind your AI assistant. What it does with what it reads is covered by that provider’s terms and privacy policy, not by ours.',
      },
      sharing: {
        title: 'Sharing and who can see what',
        body: 'A connection is private when you add it: only you see its items. When you add it to a block, everyone in the workspace sees its items on that block, and you can stop sharing it at any time.\n\nEach member has a role: owners manage the workspace and its members, editors can change things, and viewers can only look. An owner can also limit a member to certain topics, and that member then sees only those.\n\nYou bring people in with an email invitation or a join link. Anyone who joins can see what their role and topics allow, so share links only with people you trust. You can remove a member or revoke a link at any time.\n\nWe don’t share your information with anyone else, apart from the sub-processors below, or when the law requires it, such as a court order.',
      },
      travel: {
        title: 'Places and travel time',
        body: 'Travel time is optional. When you turn it on, TodoList keeps the places you save (Home, campus, the gym), with an address if you type one, together with your travel rules, your settings and how long you say each trip takes.\n\nNothing about your places or trips is sent to any other service: TodoList doesn’t look addresses up and doesn’t work routes out. You set how long each trip takes yourself.\n\nYour places and addresses are private to you: they are never shared with other members of a workspace, never logged, and never given to AI agents, which see place names only. An address is used only to open a map app on your device, when you tap Waze or Google Maps on a trip. A travel leg on your calendar carries place names only, and only you can see it. When you leave a workspace, your places, travel rules and travel settings are deleted at once, and your legs leave your calendar (they are deleted for good as described under “How long we keep things”).',
      },
      secrets: {
        title: 'How connection secrets are stored',
        body: 'Tokens and keys you give us are encrypted at rest with AES-256-GCM, under a separate encryption key for each stage of the service held in AWS KMS. Each secret is bound to the workspace and the connection it belongs to, so it can’t be used anywhere else.\n\nSecrets are write-only. After you save one it is never shown again, and it is never sent to your browser or to AI agents. Only the sync and calendar processes can decrypt a secret, and only when they need it.\n\nWhen you disconnect a source, we delete the stored secret, and we revoke it at Google where Google supports that.',
      },
      processors: {
        title: 'Sub-processors',
        body: 'These companies host and run TodoList for us. They process your information only on our behalf, under their own data protection terms:\n\n- Amazon Web Services (AWS): runs the service in its Israel (Tel Aviv) region, delivers the website worldwide (Amazon CloudFront), handles sign-in (Amazon Cognito), holds the encryption keys (AWS KMS), stores profile photos and sends our email (Amazon SES). <aws>AWS privacy notice</aws>\n- MongoDB Atlas: hosts the database that holds your workspaces and items, in Frankfurt, Germany (European Union). <mongodb>MongoDB privacy policy</mongodb>\n- Google Cloud: runs sign-in with Google (OAuth) for the Google Calendar connection. <google>Google privacy policy</google>\n\nThe tools you connect are not our sub-processors. They are services you use yourself, and their own policies apply (see “Connected sources”).',
      },
      transfers: {
        title: 'Where your data is stored',
        body: 'TodoList runs in the Israel (Tel Aviv) region of Amazon Web Services. The service itself, sign-in (Amazon Cognito), the encryption keys (AWS KMS), the files you upload, our email (Amazon SES) and the service logs are all there.\n\nThe database that holds your workspaces and items is hosted by MongoDB Atlas in Frankfurt, Germany, in the European Union. So your information is transferred outside Israel, to the EU. Israel’s rules on transferring personal information abroad allow transfers to countries of the European Union, and EU data protection law applies to it there.\n\nSome of your information also passes through other countries:\n\n- The website reaches you through Amazon CloudFront, AWS’s worldwide delivery network. Your connection goes through the location nearest you, and copies of the site’s public files may be kept there.\n- Google runs sign-in with Google on its own servers around the world.\n- The tools you connect keep your data wherever they run, under their own policies (see “Connected sources”).\n\nWherever your information goes, it stays with these providers, protected by their own data protection commitments.',
      },
      retention: {
        title: 'How long we keep things',
        body: '- Your account and workspaces: for as long as you keep them.\n- Items you delete, and the items of a source you disconnect: they leave your dashboards right away, and are deleted for good 30 days later, by a clean-up that runs every day. If you want them gone sooner, write to us.\n- Travel legs you skip, or that no longer apply: deleted for good 30 days later too, but never before 30 days after the trip, so TodoList doesn’t plan them again.\n- Connection secrets: deleted as soon as you disconnect the source, or its workspace is deleted.\n- Invitations: deleted automatically 7 days after they are sent.\n- The activity log: each entry is deleted automatically after one year.\n- Service logs: deleted automatically after 30 days.\n\nWhen you delete your account, we delete your profile, your uploads and your sign-in right away. The workspaces only you own are deleted too: their connection secrets, pages, topics and travel data at once, and their items as described above. Your memberships in other workspaces end, and your agent keys stop working.',
      },
      security: {
        title: 'How we protect it',
        body: '- Every connection to TodoList is encrypted (HTTPS).\n- Connection secrets are encrypted with AES-256-GCM under keys held in AWS KMS (see “How connection secrets are stored”).\n- The service reaches its database with short-lived AWS credentials, not a stored password.\n- A web application firewall and rate limits protect the service from abuse.\n- Passwords are handled by Amazon Cognito and never stored by TodoList.\n- Important actions are recorded in each workspace’s activity log.\n\nNo service can promise perfect security. If a security incident puts your personal information at risk, we will tell you and report it to Israel’s Privacy Protection Authority, as the law requires.',
      },
      rights: {
        title: 'Your rights',
        body: 'Under Israel’s Protection of Privacy Law, you can see the personal information we hold about you, and ask us to correct or delete information that is wrong, incomplete, unclear or out of date. We give these rights to everyone, wherever they live, and most of them work right in the app:\n\n- See and download: your profile shows your account details, and “Export my data” downloads your profile and the files you uploaded.\n- Correct: change your name and photo in your profile, and your items in TodoList or in the tool they come from.\n- Delete: delete items, disconnect tools, leave workspaces or delete your account, all in the app.\n- Ask us: for anything else, including a full copy of your information, write to <email>{{contactEmail}}</email>. We may ask you to confirm it’s you, and we answer within 30 days.\n\nIf you think we have not handled your information properly, please tell us first so we can fix it. You can also complain to Israel’s <authority>Privacy Protection Authority</authority>.',
      },
      cookies: {
        title: 'Cookies and browser storage',
        body: 'TodoList doesn’t use advertising, analytics or tracking cookies, and it loads no third-party tracking scripts. It uses only what it needs to work:\n\n- one short-lived cookie while you connect a tool, which checks that the sign-in coming back is yours;\n- your browser’s storage, for your sign-in session, your language, your theme, the workspace you last opened and the state of the sidebar.\n\nTodoList can’t work without these, so we don’t ask for consent to them. Signing out ends your session, and clearing your browser’s data for the site removes the rest.',
      },
      children: {
        title: 'Children',
        body: 'TodoList isn’t meant for children under 16. We don’t knowingly collect their data, and if we find out we have, we delete it.',
      },
      changes: {
        title: 'Changes to this policy',
        body: 'When we change this policy, we update the date at the top of this page. If a change matters, for example a new kind of information we collect or a new sub-processor, we’ll email you before it takes effect.',
      },
      contact: {
        title: 'Contact',
        body: 'Questions and requests about privacy go to <email>{{contactEmail}}</email>. You can write to us in English or Hebrew.',
      },
    },
  },
  terms: {
    title: 'Terms of service',
    metaTitle: 'Terms of service',
    intro:
      'These terms are the agreement between you and TodoList when you use the TodoList website and app at todolist.shalev396.com and its MCP server. We kept them short and plain on purpose.',
    sections: {
      summary: {
        title: 'The short version',
        body: '- TodoList is free for individuals.\n- Use it lawfully, connect only accounts you’re allowed to use, and take care of the workspaces you share.\n- Your content stays yours.\n- The service is provided as is, and Israeli law applies.',
      },
      agreement: {
        title: 'Who these terms are with',
        body: 'TodoList is built and run by Shalev Ben Moshe, an independent developer in Israel (“we”, “us”). By creating an account or using TodoList, you agree to these terms, and you confirm you have read the Privacy policy, which explains how we handle your information. If you don’t agree, please don’t use TodoList.',
      },
      eligibility: {
        title: 'Who can use TodoList',
        body: 'You need to be at least 16 years old to use TodoList. If you use it for a company, a school or another organization, you confirm you are allowed to accept these terms for it.',
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
        body: 'You need an account to use TodoList. Use an email address you can reach, keep your password safe, and tell us right away if you think someone else is using your account. You’re responsible for what happens in your account, including what AI agents do with the keys and sign-ins you give them.',
      },
      acceptableUse: {
        title: 'Acceptable use',
        body: 'You may use TodoList to plan your studies, work and life, to connect the tools you use, to share workspaces with people you choose, and to let AI agents you trust work with your workspace.\n\nYou may not:\n\n- break the law, or use TodoList to harm, harass, threaten or deceive anyone;\n- connect an account, token or key you aren’t allowed to use, or reach data you have no right to see;\n- add or share content that is illegal, or that infringes someone else’s rights, including their privacy or intellectual property;\n- send spam or unwanted invitations;\n- probe, scan or attack the service, or try to get around its limits, its sign-in or its permissions;\n- overload or disrupt the service, for example with automated requests far beyond normal use;\n- upload malware or anything else meant to harm the service or the people who use it;\n- pretend to be someone else, or misrepresent your connection to a person or an organization;\n- resell or sublicense access to the hosted service.\n\nFound a security problem? Please report it to us privately, as the security policy in our <repo>GitHub repository</repo> describes, instead of testing it against the live service.',
      },
      content: {
        title: 'Your content',
        body: 'What you put into TodoList, and the items it copies from your tools, stay yours. You let us store, copy, process and show that content only as needed to run TodoList for you and for the people you share it with, and for no other purpose. You’re responsible for the content you add and for having the right to add it.',
      },
      responsibilities: {
        title: 'Connected accounts and shared workspaces',
        body: 'Connect only accounts and tokens you have the right to use, and keep them valid. You’re responsible for what you connect.\n\nWhen you switch a connection to Read & write, the changes you make in TodoList, and the to-dos you choose to send, are written to that tool. Check what you send before you send it.\n\nWhen you invite people or share a join link, you choose to share that workspace’s data with them. Owners decide who can edit and who can only view, and who sees which topics.',
      },
      thirdParty: {
        title: 'Third-party services',
        body: 'Jira, ClickUp, Linear, Moodle, Google, GitHub and the AI assistants you connect each have their own terms, and they still apply to you when you use them through TodoList. We aren’t responsible for those services, for what’s in them, or for changes they make that stop a connection from working.',
      },
      openSource: {
        title: 'Open source',
        body: 'TodoList’s code is open source and you can read it <repo>on GitHub</repo>. Its license covers the code; these terms cover your use of the hosted service.',
      },
      availability: {
        title: 'Changes to the service',
        body: 'TodoList is a free service, and it keeps improving. We may add, change or remove features, and set technical limits that keep it running for everyone. We may also stop offering TodoList. If we do, we’ll email you at least 30 days before, so you can export your data and move what matters to you.',
      },
      warranty: {
        title: 'Provided as is',
        body: 'We work to keep TodoList running and your data safe, but the service is provided “as is” and “as available”, without warranties of any kind, and it may be unavailable or make mistakes at times. Your items still live in the original tools, so keep anything important there too.',
      },
      liability: {
        title: 'Limitation of liability',
        body: 'As far as the law allows, we aren’t liable for indirect or consequential losses, for missed deadlines, lost data, lost profits or downtime, or for what a connected tool or an AI agent does. Because TodoList is free, our total liability to you for any claim is limited to 100 new shekels (NIS 100).\n\nNothing in these terms limits a liability that the law doesn’t allow us to limit, or takes away rights you have as a consumer under the law.',
      },
      ending: {
        title: 'Ending your account',
        body: 'You can stop using TodoList and delete your account at any time, from your profile. Deleting it removes your data as the Privacy policy describes.\n\nWe may suspend or close an account that breaks these terms, puts other people or the service at risk, or that the law requires us to close. When it’s reasonable, we’ll tell you first and give you a chance to fix the problem or export your data.',
      },
      law: {
        title: 'Governing law and courts',
        body: 'These terms are governed by the laws of the State of Israel. Any dispute about them or about TodoList belongs exclusively to the competent courts in Tel Aviv-Yafo, Israel. If you live outside Israel, you keep any protection that the law where you live gives you and that can’t be waived by agreement.',
      },
      changes: {
        title: 'Changes to these terms',
        body: 'We may update these terms, and we change the date at the top of this page when we do. If a change matters, we’ll email you before it takes effect. If you keep using TodoList after that, you accept the new terms; if you don’t accept them, you can delete your account.',
      },
      general: {
        title: 'General',
        body: 'If a court finds part of these terms unenforceable, the rest still applies. If we don’t enforce a term right away, we haven’t given it up. These terms and the Privacy policy are the whole agreement between you and us about TodoList.',
      },
      contact: {
        title: 'Contact',
        body: 'Questions about these terms go to <email>{{contactEmail}}</email>.',
      },
    },
  },
};
