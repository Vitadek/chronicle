import type { NextFunction, Request, RequestHandler, Response } from 'express';

/** Express 4 does not forward rejected async handlers to error middleware. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next);
  };
}
