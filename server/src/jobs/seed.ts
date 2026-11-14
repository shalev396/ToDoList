/**
 * The `seed` direct-invoke action: demo data for the dev stage (D17: demo specifics live only in
 * the seed). Refused on every other stage. A stub until the seed task fills it in: on dev it
 * answers 501 instead of writing anything.
 */
import { environment } from '../config/environment.js';
import { AppError } from '../errors/AppError.js';
import type { Env } from '../types/env.d.ts';

export function seedStage(env: Env = environment.env): Promise<never> {
  if (env !== 'dev') {
    return Promise.reject(
      new AppError(403, `seed is only allowed on the dev stage (this is ${env})`),
    );
  }
  return Promise.reject(new AppError(501, 'seed is not available yet'));
}
