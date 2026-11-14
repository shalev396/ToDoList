import type { IUserRepository } from './definitions/User.js';
import type { IMediaRepository } from './definitions/Media.js';
import { AGENT_KEY_TABLE_NAME, type IAgentKeyRepository } from './definitions/AgentKey.js';
import { AUDIT_LOG_TABLE_NAME, type IAuditLogRepository } from './definitions/AuditLog.js';
import {
  CALENDAR_LINK_TABLE_NAME,
  type ICalendarLinkRepository,
} from './definitions/CalendarLink.js';
import { CONTAINER_TABLE_NAME, type IContainerRepository } from './definitions/Container.js';
import { CREDENTIAL_TABLE_NAME, type ICredentialRepository } from './definitions/Credential.js';
import { DASHBOARD_TABLE_NAME, type IDashboardRepository } from './definitions/Dashboard.js';
import {
  DASHBOARD_VERSION_TABLE_NAME,
  type IDashboardVersionRepository,
} from './definitions/DashboardVersion.js';
import { INTEGRATION_TABLE_NAME, type IIntegrationRepository } from './definitions/Integration.js';
import { INVITE_TABLE_NAME, type IInviteRepository } from './definitions/Invite.js';
import { ITEM_TABLE_NAME, type IItemRepository } from './definitions/Item.js';
import { MEMBERSHIP_TABLE_NAME, type IMembershipRepository } from './definitions/Membership.js';
import { OAUTH_STATE_TABLE_NAME, type IOAuthStateRepository } from './definitions/OAuthState.js';
import { REPLAY_NONCE_TABLE_NAME, type IReplayNonceRepository } from './definitions/ReplayNonce.js';
import { CREATE_QUOTA_TABLE_NAME, type ICreateQuotaRepository } from './definitions/CreateQuota.js';
import { SYNC_RUN_TABLE_NAME, type ISyncRunRepository } from './definitions/SyncRun.js';
import { SYNC_STATE_TABLE_NAME, type ISyncStateRepository } from './definitions/SyncState.js';
import { TOPIC_TABLE_NAME, type ITopicRepository } from './definitions/Topic.js';
import { VIEW_TABLE_NAME, type IViewRepository } from './definitions/View.js';
import { WORKSPACE_TABLE_NAME, type IWorkspaceRepository } from './definitions/Workspace.js';
import { NotSupportedError } from './errors.js';
import { environment } from '../config/environment.js';

export type { UserData, IUserRepository } from './definitions/User.js';
export type { MediaData, IMediaRepository } from './definitions/Media.js';
export type { WorkspaceData, IWorkspaceRepository, JoinLinkData } from './definitions/Workspace.js';
export type { MembershipData, IMembershipRepository } from './definitions/Membership.js';
export type { InviteData, IInviteRepository } from './definitions/Invite.js';
export type { IntegrationData, IIntegrationRepository } from './definitions/Integration.js';
export type { CredentialData, ICredentialRepository } from './definitions/Credential.js';
export type { ItemData, IItemRepository } from './definitions/Item.js';
export type { ContainerData, IContainerRepository } from './definitions/Container.js';
export type { SyncStateData, ISyncStateRepository } from './definitions/SyncState.js';
export type { SyncRunData, ISyncRunRepository } from './definitions/SyncRun.js';
export type { AuditLogData, IAuditLogRepository } from './definitions/AuditLog.js';
export type { DashboardData, IDashboardRepository } from './definitions/Dashboard.js';
export type {
  DashboardVersionData,
  IDashboardVersionRepository,
} from './definitions/DashboardVersion.js';
export type { ViewData, IViewRepository } from './definitions/View.js';
export type { TopicData, ITopicRepository } from './definitions/Topic.js';
export type { AgentKeyData, IAgentKeyRepository } from './definitions/AgentKey.js';
export type { CalendarLinkData, ICalendarLinkRepository } from './definitions/CalendarLink.js';
export type { IReplayNonceRepository } from './definitions/ReplayNonce.js';
export type { OAuthStateData, IOAuthStateRepository } from './definitions/OAuthState.js';

let _userRepository: IUserRepository | null = null;
let _mediaRepository: IMediaRepository | null = null;

export async function getUserRepository(): Promise<IUserRepository> {
  if (_userRepository !== null) {
    return _userRepository;
  }

  if (environment.databaseProvider === 'mongoose') {
    const { UserRepository } = await import('./mongoose/User.js');
    _userRepository = UserRepository;
  } else {
    const { UserRepository } = await import('./sequelize/User.js');
    _userRepository = UserRepository;
  }

  return _userRepository;
}

export async function getMediaRepository(): Promise<IMediaRepository> {
  if (_mediaRepository !== null) {
    return _mediaRepository;
  }

  if (environment.databaseProvider === 'mongoose') {
    const { MediaRepository } = await import('./mongoose/Media.js');
    _mediaRepository = MediaRepository;
  } else {
    const { MediaRepository } = await import('./sequelize/Media.js');
    _mediaRepository = MediaRepository;
  }

  return _mediaRepository;
}

/**
 * A lazy getter for a MongoDB-only repository (the dashboard collections): it loads the Mongoose
 * module on first use, and throws NotSupportedError when DATABASE_URL points at PostgreSQL.
 */
function mongoOnly<T>(collection: string, load: () => Promise<T>): () => Promise<T> {
  let repository: T | null = null;
  return async (): Promise<T> => {
    if (repository !== null) return repository;
    if (environment.databaseProvider !== 'mongoose') throw new NotSupportedError(collection);
    repository = await load();
    return repository;
  };
}

export const getWorkspaceRepository = mongoOnly<IWorkspaceRepository>(
  WORKSPACE_TABLE_NAME,
  async () => (await import('./mongoose/Workspace.js')).WorkspaceRepository,
);

export const getMembershipRepository = mongoOnly<IMembershipRepository>(
  MEMBERSHIP_TABLE_NAME,
  async () => (await import('./mongoose/Membership.js')).MembershipRepository,
);

export const getInviteRepository = mongoOnly<IInviteRepository>(
  INVITE_TABLE_NAME,
  async () => (await import('./mongoose/Invite.js')).InviteRepository,
);

export const getIntegrationRepository = mongoOnly<IIntegrationRepository>(
  INTEGRATION_TABLE_NAME,
  async () => (await import('./mongoose/Integration.js')).IntegrationRepository,
);

export const getCredentialRepository = mongoOnly<ICredentialRepository>(
  CREDENTIAL_TABLE_NAME,
  async () => (await import('./mongoose/Credential.js')).CredentialRepository,
);

export const getItemRepository = mongoOnly<IItemRepository>(
  ITEM_TABLE_NAME,
  async () => (await import('./mongoose/Item.js')).ItemRepository,
);

export const getContainerRepository = mongoOnly<IContainerRepository>(
  CONTAINER_TABLE_NAME,
  async () => (await import('./mongoose/Container.js')).ContainerRepository,
);

export const getSyncStateRepository = mongoOnly<ISyncStateRepository>(
  SYNC_STATE_TABLE_NAME,
  async () => (await import('./mongoose/SyncState.js')).SyncStateRepository,
);

export const getSyncRunRepository = mongoOnly<ISyncRunRepository>(
  SYNC_RUN_TABLE_NAME,
  async () => (await import('./mongoose/SyncRun.js')).SyncRunRepository,
);

export const getAuditLogRepository = mongoOnly<IAuditLogRepository>(
  AUDIT_LOG_TABLE_NAME,
  async () => (await import('./mongoose/AuditLog.js')).AuditLogRepository,
);

export const getDashboardRepository = mongoOnly<IDashboardRepository>(
  DASHBOARD_TABLE_NAME,
  async () => (await import('./mongoose/Dashboard.js')).DashboardRepository,
);

export const getDashboardVersionRepository = mongoOnly<IDashboardVersionRepository>(
  DASHBOARD_VERSION_TABLE_NAME,
  async () => (await import('./mongoose/DashboardVersion.js')).DashboardVersionRepository,
);

export const getViewRepository = mongoOnly<IViewRepository>(
  VIEW_TABLE_NAME,
  async () => (await import('./mongoose/View.js')).ViewRepository,
);

export const getTopicRepository = mongoOnly<ITopicRepository>(
  TOPIC_TABLE_NAME,
  async () => (await import('./mongoose/Topic.js')).TopicRepository,
);

export const getAgentKeyRepository = mongoOnly<IAgentKeyRepository>(
  AGENT_KEY_TABLE_NAME,
  async () => (await import('./mongoose/AgentKey.js')).AgentKeyRepository,
);

export const getCalendarLinkRepository = mongoOnly<ICalendarLinkRepository>(
  CALENDAR_LINK_TABLE_NAME,
  async () => (await import('./mongoose/CalendarLink.js')).CalendarLinkRepository,
);

export const getReplayNonceRepository = mongoOnly<IReplayNonceRepository>(
  REPLAY_NONCE_TABLE_NAME,
  async () => (await import('./mongoose/ReplayNonce.js')).ReplayNonceRepository,
);

export const getCreateQuotaRepository = mongoOnly<ICreateQuotaRepository>(
  CREATE_QUOTA_TABLE_NAME,
  async () => (await import('./mongoose/CreateQuota.js')).CreateQuotaRepository,
);

export const getOAuthStateRepository = mongoOnly<IOAuthStateRepository>(
  OAUTH_STATE_TABLE_NAME,
  async () => (await import('./mongoose/OAuthState.js')).OAuthStateRepository,
);
