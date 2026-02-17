import { Request, Response, NextFunction } from 'express';
import logger from '../logger';

/**
 * Middleware to log all incoming HTTP requests
 */
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  const startTime = Date.now();

  // Log incoming request
  logger.info('Incoming request', {
    method: req.method,
    url: req.url,
    path: req.path,
    query: req.query,
    headers: req.headers,
    body: req.body,
    ip: req.ip,
  });

  // Log response when finished
  res.on('finish', () => {
    const duration = Date.now() - startTime;

    const logLevel = res.statusCode >= 400 ? 'error' : 'info';

    logger[logLevel]('Request completed', {
      method: req.method,
      url: req.url,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
    });
  });

  next();
};
