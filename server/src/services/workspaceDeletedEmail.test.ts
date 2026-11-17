import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { workspaceDeletedEmail } from './workspaceDeletedEmail.js';

describe('the workspace-deleted email (PERMISSIONS-V2 ruling 11)', () => {
  it('says the workspace was deleted and the connections removed, in English and Hebrew', () => {
    const email = workspaceDeletedEmail({ to: 'dana@example.test', workspaceName: 'Study group' });
    assert.equal(email.to, 'dana@example.test');
    assert.equal(email.subject, 'TodoList: "Study group" was deleted');
    assert.match(
      email.textBody,
      /The workspace "Study group" was deleted; your connections to it were removed\./,
    );
    assert.match(email.textBody, /מרחב העבודה "Study group" נמחק/);
    assert.match(email.htmlBody, /dir="rtl" lang="he"/);
  });

  it('keeps a typed name on one line in the subject and escapes it in the HTML', () => {
    const email = workspaceDeletedEmail({
      to: 'x@example.test',
      workspaceName: 'A <b>bold</b>\nname',
    });
    assert.equal(email.subject, 'TodoList: "A <b>bold</b> name" was deleted');
    assert.ok(!email.htmlBody.includes('<b>bold</b>'));
    assert.match(email.htmlBody, /&lt;b&gt;bold&lt;\/b&gt;/);
  });

  it('names no account, provider or link', () => {
    const email = workspaceDeletedEmail({ to: 'x@example.test', workspaceName: 'W' });
    for (const text of [email.textBody, email.htmlBody]) {
      assert.ok(!/https?:\/\//.test(text));
      assert.ok(!/jira|github|google|linear|clickup|moodle/i.test(text));
    }
  });
});
