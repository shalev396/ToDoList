/**
 * Getting an invite to the invitee: the link to the accept page, and the email that carries it.
 * The link holds the raw token, so the email body is never logged.
 */
import { environment } from '../config/environment.js';
import type { InviteData } from '../models/index.js';
import type { Role } from '../types/domain.js';
import { escapeHtml, sendEmail, type SendEmailParams } from '../utils/sesUtil.js';
import type { WorkspaceContext } from './accessFilter.js';
import { logger } from './logger.js';
import { getWorkspace } from './workspaces.js';
import { findUser } from './users.js';

export type InviteLanguage = 'en' | 'he';

export interface InviteEmailInput {
  to: string;
  workspaceName: string;
  inviterName: string | null;
  role: Role;
  url: string;
  expiresAt: Date;
  /** What the inviter wrote, if anything. Shown in the body, never in the subject. */
  message?: string | null | undefined;
  /** The inviter's language: the email's. Default: en. */
  language?: InviteLanguage | undefined;
}

/** The client's accept page for a raw token, on the stage's own domain. */
export function inviteUrl(rawToken: string, domainName: string = environment.domainName): string {
  return `https://${domainName}/en/invites/${encodeURIComponent(rawToken)}`;
}

/** The client's join page for a join-link token (anyone with the link, A2). */
export function joinUrl(rawToken: string, domainName: string = environment.domainName): string {
  return `https://${domainName}/en/join/${encodeURIComponent(rawToken)}`;
}

/** Names typed by users, on one line (an email subject must not span lines). */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

interface InviteWords {
  dir: 'ltr' | 'rtl';
  lang: string;
  /** "Ada invited you to view the workspace "X"" (no closing punctuation). */
  headline: (inviter: string, role: Role, workspace: string) => string;
  onApp: string;
  says: (inviter: string) => string;
  accept: string;
  accessLine: (to: string, expires: string) => string;
  fallbackInviter: string;
}

const WORDS: Record<InviteLanguage, InviteWords> = {
  en: {
    dir: 'ltr',
    lang: 'en',
    headline: (inviter, role, workspace) =>
      `${inviter} invited you to ${role === 'editor' ? 'edit' : 'view'} the workspace "${workspace}"`,
    onApp: ' on TodoList.',
    says: (inviter) => `${inviter} says:`,
    accept: 'Accept the invite',
    accessLine: (to, expires) => `The link works once, only for ${to}, until ${expires}.`,
    fallbackInviter: 'Someone',
  },
  he: {
    dir: 'rtl',
    lang: 'he',
    headline: (inviter, role, workspace) =>
      `הוזמנת על ידי ${inviter} ${role === 'editor' ? 'לערוך' : 'לצפות'} במרחב העבודה "${workspace}"`,
    onApp: ' ב-TodoList.',
    says: (inviter) => `${inviter} כתב/ה:`,
    accept: 'לקבלת ההזמנה',
    accessLine: (to, expires) => `הקישור עובד פעם אחת, רק עבור ${to}, עד ${expires}.`,
    fallbackInviter: 'מישהו',
  },
};

/**
 * The invite email, in the inviter's language: "Ada invited you to view|edit the workspace "X"",
 * the inviter's message if any, and an Accept button to the invite link. The link works once.
 */
export function inviteEmail(invite: InviteEmailInput): SendEmailParams {
  const words = WORDS[invite.language ?? 'en'];
  const workspace = oneLine(invite.workspaceName);
  const inviter = oneLine(invite.inviterName ?? '') || words.fallbackInviter;
  const expires = invite.expiresAt.toUTCString();
  const message = invite.message?.trim() ?? '';
  const headline = words.headline(inviter, invite.role, workspace);
  const subject = headline;
  const textBody = [
    `${headline}${words.onApp}`,
    '',
    ...(message === '' ? [] : [words.says(inviter), message, '']),
    `${words.accept}: ${invite.url}`,
    '',
    words.accessLine(invite.to, expires),
    '',
  ].join('\n');
  const messageHtml =
    message === ''
      ? ''
      : `<blockquote style="margin: 0 0 16px; padding: 8px 12px; border-inline-start: 3px solid #ccc; color: #555;"><strong>${escapeHtml(words.says(inviter))}</strong><br>${escapeHtml(message).replace(/\r?\n/g, '<br>')}</blockquote>`;
  const htmlBody = `
    <!DOCTYPE html>
    <html lang="${words.lang}" dir="${words.dir}">
    <head><meta charset="UTF-8"></head>
    <body dir="${words.dir}" style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #333;">
      <p>${escapeHtml(words.headline(inviter, invite.role, workspace))}${escapeHtml(words.onApp)}</p>
      ${messageHtml}
      <p><a href="${escapeHtml(invite.url)}" style="display: inline-block; padding: 10px 18px; background: #111; color: #fff; text-decoration: none; border-radius: 6px;">${escapeHtml(words.accept)}</a></p>
      <p style="color: #999; font-size: 12px;">${escapeHtml(words.accessLine(invite.to, expires))}</p>
    </body>
    </html>
  `.trim();
  return { to: invite.to, subject, htmlBody, textBody };
}

export async function sendInviteEmail(invite: InviteEmailInput): Promise<void> {
  await sendEmail(inviteEmail(invite));
}

/**
 * Emails an invite's link to the invitee, straight through SES from this request (no queue, like
 * Elytra). A failed email doesn't fail the invite: it is logged, and the inviter still has the
 * link to share or can invite again. The REST route and the MCP tool both deliver through here.
 */
export async function emailInvite(
  ctx: WorkspaceContext,
  inviterId: string,
  invite: InviteData,
  url: string,
  extras: { message?: string | null | undefined; language?: InviteLanguage | undefined } = {},
): Promise<void> {
  try {
    const [workspace, inviter] = await Promise.all([getWorkspace(ctx), findUser(inviterId)]);
    await sendInviteEmail({
      to: invite.email,
      workspaceName: workspace.workspace.name,
      inviterName: inviter?.name ?? null,
      role: invite.role,
      url,
      expiresAt: invite.expiresAt,
      message: extras.message ?? null,
      language: extras.language,
    });
  } catch (error) {
    logger.error('The invite email could not be sent', error);
  }
}
