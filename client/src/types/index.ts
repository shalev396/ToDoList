import type { LoginResponseData } from '@api-types/api-contracts';

export type User = LoginResponseData['user'];

export interface ApiRequestConfig {
  suppressErrorToast?: boolean;
  /** Cancels the request (React Query passes one to every query function). */
  signal?: AbortSignal;
  /** Sends and keeps cookies across origins (the API on another port in local development). */
  withCredentials?: boolean;
}
