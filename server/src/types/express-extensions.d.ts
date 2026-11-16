declare namespace Express {
  interface Response {
    success(data: unknown, statusCode?: number): void;
    /** `code`: a machine code from types/errorCodes.ts (`ErrorCode`), for the client to translate. */
    error(message: string, statusCode?: number, code?: string): void;
  }
}
