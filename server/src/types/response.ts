export interface ApiSuccessResponse<T = unknown> {
  data: T;
}

export interface ApiErrorResponse {
  message: string;
  /** A machine code (types/errorCodes.ts) the client translates; absent for generic errors. */
  code?: string;
}

/** `data` of a success response that carries nothing: `{ "data": {} }`. */
export type EmptySuccessResponseData = Record<string, never>;

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;
