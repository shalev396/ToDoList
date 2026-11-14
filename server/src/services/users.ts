import { AppError } from '../errors/AppError.js';
import { getUserRepository, type UserData } from '../models/index.js';

/** The user row, or null. */
export async function findUser(userId: string): Promise<UserData | null> {
  return (await getUserRepository()).findById(userId);
}

/** The signed-in user's row (email, name, default workspace); 404 when it is gone. */
export async function requireUser(userId: string): Promise<UserData> {
  const user = await findUser(userId);
  if (user === null) throw new AppError(404, 'User not found');
  return user;
}
