import type { RequestHandler } from 'express';

import { OpValidationError } from '../builder/errors.js';
import { ConflictError } from '../errors/ConflictError.js';
import { redactString } from '../services/secretPatterns.js';

/**
 * Wraps a dashboard/builder/view handler so the Logic Bridge's errors keep their detail:
 * - ConflictError → `409 {message, currentVersion}` (refetch, then retry);
 * - OpValidationError → `400 {message, pointer}` (the pointer locates the problem).
 * Anything else goes on to the error handler.
 */
export function withBuilderErrors(handler: RequestHandler): RequestHandler {
  return async (req, res, next): Promise<void> => {
    try {
      await handler(req, res, next);
    } catch (error) {
      if (error instanceof ConflictError) {
        res.status(409).json({ message: error.message, currentVersion: error.currentVersion });
        return;
      }
      if (error instanceof OpValidationError) {
        res.status(400).json({ message: redactString(error.message), pointer: error.pointer });
        return;
      }
      throw error;
    }
  };
}
