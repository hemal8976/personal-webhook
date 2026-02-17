import dotenv from 'dotenv';
import express, { Request, Response, NextFunction } from 'express';
import { AddressInfo } from 'node:net';
import { registerRoutes } from './routes';
import { requestLogger } from './middleware/requestLogger';
import logger from './logger';

// Load environment variables
dotenv.config();

const PORT = process.env.PORT || 9999;
const NODE_ENV = process.env.NODE_ENV || 'development';

// Create Express app
const app = express();

// Middleware
app.use(express.json({ limit: '10mb' })); // Parse JSON bodies
app.use(express.urlencoded({ extended: true, limit: '10mb' })); // Parse URL-encoded bodies
app.use(requestLogger); // Log all requests

// Register all webhook routes
registerRoutes(app);

// 404 handler for unknown paths
app.use((req: Request, res: Response) => {
  logger.warn('Route not found', {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });

  res.status(404).json({
    error: 'Not found',
    message: `Cannot ${req.method} ${req.path}`,
    availableEndpoints: 'Visit GET / for a list of available endpoints',
  });
});

// Global error handler
app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  logger.error('Unhandled error', {
    error: err.message,
    stack: err.stack,
    method: req.method,
    path: req.path,
  });

  res.status(500).json({
    error: 'Internal server error',
    message: NODE_ENV === 'development' ? err.message : 'Something went wrong',
  });
});

let isShuttingDown = false;
let listenRetryCount = 0;
const maxListenRetries = 5;
const listenRetryDelayMs = 500;

const server = app.listen(PORT, () => {
  const address = server.address() as AddressInfo | null;
  const actualPort = address?.port || PORT;

  logger.info('='.repeat(60));
  logger.info('Personal Webhook Server Started', {
    port: actualPort,
    environment: NODE_ENV,
    nodeVersion: process.version,
  });
  logger.info(`Local:      http://localhost:${actualPort}`);
  logger.info(`Network:    http://0.0.0.0:${actualPort}`);
  logger.info('='.repeat(60));
  logger.info('Available endpoints:');
  logger.info('  GET  /         - Server info and available routes');
  logger.info('  GET  /health   - Health check');
  logger.info('  POST /fathom   - Fathom AI webhook');
  logger.info('='.repeat(60));
});

server.on('error', error => {
  if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE' && listenRetryCount < maxListenRetries) {
    listenRetryCount += 1;
    logger.warn('Port is busy, retrying listen', {
      port: PORT,
      attempt: `${listenRetryCount}/${maxListenRetries}`,
      delayMs: listenRetryDelayMs,
    });

    setTimeout(() => {
      server.close();
      server.listen(PORT);
    }, listenRetryDelayMs);
    return;
  }

  logger.error('Server failed to start', {
    error: error instanceof Error ? error.message : 'Unknown error',
  });
  process.exit(1);
});

const gracefulShutdown = (signal: NodeJS.Signals): void => {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  logger.info(`${signal} received, shutting down gracefully`);

  server.close(closeError => {
    if (closeError) {
      logger.error('Error while closing server', { error: closeError.message });
      process.exit(1);
      return;
    }

    logger.info('HTTP server closed');
    process.exit(0);
  });
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
