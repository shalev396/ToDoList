import { getUserRepository, type UserData } from '../models/index.js';
import {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { environment } from '../config/environment.js';
import type { Actor } from './base/Actor.js';
import { Entity } from './base/Entity.js';
import { Workspace } from './workspace/Workspace.js';

const cognitoClient = new CognitoIdentityProviderClient({
  region: environment.awsRegion,
});

/**
 * A signed-in person (Cognito's user, mirrored as a Users row): this class is the only code that
 * touches the Users collection. A user lives outside any workspace (an Entity, not a
 * WorkspaceEntity); `deleteAccount` runs the workspace cascade first (Workspace.deleteAccountCascade).
 */
export class User extends Entity<UserData> {
  private constructor(data: UserData) {
    super(data);
  }

  get cognitoSub(): string {
    return this.data.cognitoSub;
  }

  get name(): string | null {
    return this.data.name;
  }

  get email(): string | null {
    return this.data.email;
  }

  get photoId(): string | null {
    return this.data.photoId;
  }

  get lastLoginAt(): Date | null {
    return this.data.lastLoginAt;
  }

  get defaultWorkspaceId(): string | null {
    return this.data.defaultWorkspaceId;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  get updatedAt(): Date {
    return this.data.updatedAt;
  }

  /** The row's fields, exactly these. */
  override toJSON(): UserData {
    return {
      id: this.id,
      cognitoSub: this.cognitoSub,
      name: this.name,
      email: this.email,
      photoId: this.photoId,
      lastLoginAt: this.lastLoginAt,
      defaultWorkspaceId: this.defaultWorkspaceId,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  static async findById(id: string): Promise<User | null> {
    const repo = await getUserRepository();
    const data = await repo.findById(id);
    return data ? new User(data) : null;
  }

  static async findByCognitoSub(cognitoSub: string): Promise<User | null> {
    const repo = await getUserRepository();
    const data = await repo.findByCognitoSub(cognitoSub);
    return data ? new User(data) : null;
  }

  static async upsertFromLogin(
    cognitoSub: string,
    email: string | null,
    name: string | null,
  ): Promise<User> {
    const repo = await getUserRepository();
    const data = await repo.upsert({
      cognitoSub,
      email,
      name,
      lastLoginAt: new Date(),
    });
    return new User(data);
  }

  static async updateProfile(
    userId: string,
    data: { name?: string; photoId?: string | null },
  ): Promise<User> {
    const repo = await getUserRepository();
    const updated = await repo.updateProfile(userId, data);
    return new User(updated);
  }

  /** `actor`: the request's actor, whose address and user agent the cascade's audit entries get. */
  static async deleteAccount(userId: string, cognitoSub: string, actor?: Actor): Promise<void> {
    const repo = await getUserRepository();
    const user = await repo.findByCognitoSub(cognitoSub);

    if (user === null) {
      throw new Error('User not found');
    }

    // Workspaces first: the ones this user solely owns are deleted, every other membership
    // and agent key is revoked. If this fails, the account (Cognito and the row) is still there
    // and the request can be retried.
    await Workspace.deleteAccountCascade(userId, actor);

    try {
      const userPoolId = environment.cognitoUserPoolId;
      if (userPoolId !== undefined && userPoolId !== '') {
        await cognitoClient.send(
          new AdminDeleteUserCommand({
            UserPoolId: userPoolId,
            Username: cognitoSub,
          }),
        );
      } else {
        console.error('COGNITO_USER_POOL_ID not set, skipping Cognito deletion');
      }
    } catch (cognitoError) {
      console.error('Error deleting user from Cognito:', cognitoError);
    }

    await repo.deleteById(userId);
  }
}
