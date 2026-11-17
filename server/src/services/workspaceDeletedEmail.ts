/**
 * PERMISSIONS-V2 ruling 11: when a workspace is deleted, every member who had integrations in it
 * gets an email that says so: "Workspace X was deleted; your connections to it were removed." In
 * English and Hebrew in one message (the server keeps no language per user). Never an account,
 * a provider label or a link: only the workspace's name.
 */
import { escapeHtml, sendEmail, type SendEmailParams } from '../utils/sesUtil.js';
import { logger } from './logger.js';

/** A name typed by a user, on one line (an email subject must not span lines). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function workspaceDeletedEmail(input: {
  to: string;
  workspaceName: string;
}): SendEmailParams {
  const name = oneLine(input.workspaceName);
  const en = `The workspace "${name}" was deleted; your connections to it were removed.`;
  const he = `מרחב העבודה "${name}" נמחק; החיבורים שלך אליו הוסרו.`;
  const detailEn =
    'The credentials you connected there were deleted, and its synced items will be purged.';
  const detailHe = 'פרטי החיבור ששמרת שם נמחקו, והפריטים שסונכרנו אליו יימחקו.';
  return {
    to: input.to,
    subject: `TodoList: "${name}" was deleted`,
    textBody: [en, detailEn, '', he, detailHe, ''].join('\n'),
    htmlBody: [
      `<p dir="ltr" lang="en">${escapeHtml(en)}<br>${escapeHtml(detailEn)}</p>`,
      `<p dir="rtl" lang="he">${escapeHtml(he)}<br>${escapeHtml(detailHe)}</p>`,
    ].join('\n'),
  };
}

/** Best effort: a failed send is logged (never the address) and never blocks the deletion. */
export async function sendWorkspaceDeletedEmail(input: {
  to: string;
  workspaceName: string;
}): Promise<void> {
  try {
    await sendEmail(workspaceDeletedEmail(input));
  } catch (error) {
    logger.warn('The workspace-deleted email could not be sent', {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
