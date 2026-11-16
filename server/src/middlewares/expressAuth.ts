import { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import { verifyToken } from '../utils/cognitoUtil.js';
import { User } from '../classes/User.js';
import type { AuthenticatedRequest } from '../types/express.js';

/**
 * /api/private's authentication, in two steps so the per-user rate limit (privateLimiter) runs
 * between them, after the token is verified and before the database is read (app.ts):
 *
 *   verifyCognitoToken → privateLimiter (keyed by the verified `sub`) → loadCognitoUser
 *
 * A failed check answers `{ message: … }` with 401 (404 when the token's user does not exist).
 */

const VERIFIED_SUB = 'cognitoSub';

/** The Cognito user (`sub`) whose ID token verifyCognitoToken accepted for this request, if any. */
export function verifiedCognitoSub(res: Response): string | undefined {
  const sub: unknown = res.locals[VERIFIED_SUB];
  return typeof sub === 'string' && sub !== '' ? sub : undefined;
}

/** Step one: the Bearer ID token, verified against the user pool. Reads no database. */
export const verifyCognitoToken: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (authHeader === undefined || authHeader === '') {
      res.error('No authorization header provided', 401);
      return;
    }

    if (!authHeader.startsWith('Bearer ')) {
      res.error('Invalid authorization header format. Expected: Bearer <token>', 401);
      return;
    }

    const token = authHeader.substring(7);

    if (token === '') {
      res.error('No token provided', 401);
      return;
    }

    const decoded = await verifyToken(token);

    const cognitoSub = decoded.sub;

    if (cognitoSub === undefined || cognitoSub === '') {
      res.error('Invalid token: missing subject', 401);
      return;
    }

    res.locals[VERIFIED_SUB] = cognitoSub;
    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.error('Authentication failed', 401);
  }
};

/** Step two: the user behind the verified token (one database lookup) becomes `req.user`. */
export const loadCognitoUser: RequestHandler = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const cognitoSub = verifiedCognitoSub(res);
  if (cognitoSub === undefined) {
    // Mounted without verifyCognitoToken before it: never let the request through.
    res.error('Authentication failed', 401);
    return;
  }
  try {
    const user = await User.findByCognitoSub(cognitoSub);

    if (!user) {
      res.error('User not found', 404);
      return;
    }

    (req as AuthenticatedRequest).user = {
      id: user.id,
      cognitoSub: user.cognitoSub,
    };

    next();
  } catch (error) {
    console.error('Authentication error:', error);
    res.error('Authentication failed', 401);
  }
};
