import { User } from '../classes/User.js';
import { AppError } from '../errors/AppError.js';
import type { UserData } from '../models/definitions/User.js';

/** The user row (User#toJSON), or null. */
export async function findUser(userId: string): Promise<UserData | null> {
  return (await User.findById(userId))?.toJSON() ?? null;
}

/** The signed-in user's row (email, name, default workspace); 404 when it is gone. */
export async function requireUser(userId: string): Promise<UserData> {
  const user = await findUser(userId);
  if (user === null) throw new AppError(404, 'User not found');
  return user;
}
