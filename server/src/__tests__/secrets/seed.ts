/**
 * The seeded secrets of the leak suite. Every value is FAKE but shaped like the real thing, and is
 * built at run time from pieces: no literal in this file is a token the repo scanner would flag.
 */

export type SeedKind =
  | 'jira_token'
  | 'clickup_token'
  | 'linear_key'
  | 'moodle_token'
  | 'github_token'
  | 'github_projects_token'
  | 'service_account_pem'
  | 'mongo_uri_password'
  | 'mongo_uri'
  | 'agent_key'
  | 'session_token';

const tail = (n: number): string => 'FAKE0123456789abcdefghijKLMNOPQRSTUVWXYZ'.slice(0, n);

export const JIRA_CREDENTIAL = {
  email: 'jira-account@example.test',
  token: ['ATATT3x', tail(30)].join(''),
};
export const CLICKUP_CREDENTIAL = { token: ['pk', '_12345678_', tail(28)].join('') };
export const LINEAR_CREDENTIAL = { apiKey: ['lin', '_api_', tail(30)].join('') };
export const MOODLE_CREDENTIAL = { token: '0123456789abcdef'.repeat(2) };
export const GITHUB_CREDENTIAL = {
  token: ['github', '_pat_', tail(30), '_KLMNOP'].join(''),
  projectsToken: ['gh', 'p_', tail(34)].join(''),
};
export const SERVICE_ACCOUNT_CREDENTIAL = {
  clientEmail: 'sync@fake-project.iam.example.invalid',
  privateKey: [
    '-----BEGIN FAKE',
    ' PRIVATE KEY-----\n',
    tail(24),
    '\n-----END FAKE PRIVATE KEY-----',
  ].join(''),
};

const MONGO_PASSWORD = ['FAKEp4ss', 'w0rd', tail(8)].join('');
export const MONGO_URI = [
  'mongo',
  'db://app:',
  MONGO_PASSWORD,
  '@cluster.example.invalid/prod',
].join('');

/** Token-shaped text that users paste into a title or a note. */
export const ITEM_TITLE = `Rotate ${GITHUB_CREDENTIAL.token} before Friday`;
export const ITEM_NOTE = `Connect with ${MONGO_URI} and ${LINEAR_CREDENTIAL.apiKey}`;

export interface SeededValue {
  kind: SeedKind;
  value: string;
}

/** Provider secrets and pasted text: none may ever come back from a route or reach a log. */
export const STATIC_SECRETS: readonly SeededValue[] = [
  { kind: 'jira_token', value: JIRA_CREDENTIAL.token },
  { kind: 'clickup_token', value: CLICKUP_CREDENTIAL.token },
  { kind: 'linear_key', value: LINEAR_CREDENTIAL.apiKey },
  { kind: 'moodle_token', value: MOODLE_CREDENTIAL.token },
  { kind: 'github_token', value: GITHUB_CREDENTIAL.token },
  { kind: 'github_projects_token', value: GITHUB_CREDENTIAL.projectsToken },
  { kind: 'service_account_pem', value: SERVICE_ACCOUNT_CREDENTIAL.privateKey },
  { kind: 'mongo_uri_password', value: MONGO_PASSWORD },
  { kind: 'mongo_uri', value: MONGO_URI },
];
