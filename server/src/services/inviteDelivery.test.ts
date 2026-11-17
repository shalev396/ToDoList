import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { inviteEmail, inviteUrl } from './inviteDelivery.js';

const TOKEN = 'FAKE_token-0123456789abcdefghijklmnopqrstuv';

describe('inviteUrl', () => {
  it("points at the stage's own site", () => {
    assert.equal(
      inviteUrl(TOKEN, 'todolist.example.com'),
      `https://todolist.example.com/en/invites/${TOKEN}`,
    );
  });
});

describe('inviteEmail', () => {
  const base = {
    to: 'friend@example.test',
    workspaceName: 'Study <b>group</b>\nBcc: everyone',
    inviterName: 'Ada',
    role: 'viewer' as const,
    url: `https://todolist.example.com/en/invites/${TOKEN}`,
    expiresAt: new Date('2026-11-19T10:00:00Z'),
  };
  const email = inviteEmail(base);

  it('carries the link in both bodies, never in the subject', () => {
    assert.equal(email.to, 'friend@example.test');
    assert.ok(email.textBody.includes(`/en/invites/${TOKEN}`));
    assert.ok(email.htmlBody.includes(`/en/invites/${TOKEN}`));
    assert.ok(!email.subject.includes(TOKEN));
  });

  it('escapes the workspace name, and keeps the subject on one line', () => {
    assert.ok(email.htmlBody.includes('Study &lt;b&gt;group&lt;/b&gt;'));
    assert.ok(!email.htmlBody.includes('<b>group</b>'));
    assert.equal(
      email.subject,
      'Ada invited you to view the workspace "Study <b>group</b> Bcc: everyone"',
    );
  });

  it('follows the role: view for a viewer, edit for an editor', () => {
    const editor = inviteEmail({ ...base, role: 'editor', workspaceName: 'Plans' });
    assert.equal(editor.subject, 'Ada invited you to edit the workspace "Plans"');
    assert.ok(
      editor.textBody.startsWith('Ada invited you to edit the workspace "Plans" on TodoList.'),
    );
    assert.ok(editor.htmlBody.includes('Accept the invite'));
    const viewer = inviteEmail({ ...base, role: 'viewer', workspaceName: 'Plans' });
    assert.equal(viewer.subject, 'Ada invited you to view the workspace "Plans"');
    assert.ok(
      viewer.textBody.startsWith('Ada invited you to view the workspace "Plans" on TodoList.'),
    );
  });

  it('adds the inviter message, escaped, when there is one', () => {
    const none = inviteEmail({ ...base, message: null });
    assert.ok(!none.textBody.includes('says'));
    const withMessage = inviteEmail({ ...base, message: 'Join us <i>today</i>\nthanks' });
    assert.ok(withMessage.textBody.includes('Ada says:'));
    assert.ok(withMessage.textBody.includes('Join us <i>today</i>\nthanks'));
    assert.ok(withMessage.htmlBody.includes('Join us &lt;i&gt;today&lt;/i&gt;<br>thanks'));
    assert.ok(!withMessage.subject.includes('Join us'));
  });

  it('is in Hebrew for a Hebrew inviter, right to left, still with the link', () => {
    const he = inviteEmail({ ...base, workspaceName: 'Plans', language: 'he', role: 'editor' });
    assert.ok(he.subject.includes('מרחב העבודה "Plans"'));
    assert.ok(he.subject.includes('לערוך'));
    assert.ok(he.textBody.includes(`/en/invites/${TOKEN}`));
    assert.ok(he.htmlBody.includes('dir="rtl"'));
    const view = inviteEmail({ ...base, workspaceName: 'Plans', language: 'he' });
    assert.ok(view.subject.includes('לצפות'));
    assert.ok(!/organization|ארגון/.test(he.subject + he.textBody + he.htmlBody));
  });
});
