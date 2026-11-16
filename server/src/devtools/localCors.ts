import type { RequestHandler } from 'express';

/** The Vite dev server. CloudFront makes the deployed app same-origin; locally it is another port. */
export const LOCAL_CLIENT_ORIGIN = 'http://localhost:5173';

/** Loopback http origins on any port: the Vite dev server and the E2E runs on other ports. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}$/;

export function isLocalClientOrigin(origin: string | undefined): origin is string {
  return origin !== undefined && LOOPBACK_ORIGIN.test(origin);
}

/** CORS for the local dev server only (local.ts). Never mounted on Lambda. */
export const localCors: RequestHandler = (req, res, next) => {
  const origin = req.headers.origin;
  if (isLocalClientOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
};
