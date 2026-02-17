import { Express, Request, Response } from 'express';
import { fathomWebhookHandler } from './fathom';
import { WebhookRoute } from '../types';
import logger from '../logger';

/**
 * All webhook routes configuration
 * Add new webhook endpoints here
 */
const webhookRoutes: WebhookRoute[] = [
  {
    path: '/fathom',
    handler: fathomWebhookHandler,
    description: 'Fathom AI meeting webhook',
  },
  // Add more webhook routes here as needed:
  // {
  //   path: '/slack',
  //   handler: slackWebhookHandler,
  //   description: 'Slack event webhook',
  // },
];

/**
 * Register all webhook routes with the Express app
 */
export const registerRoutes = (app: Express): void => {
  // Health check endpoint
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    });
  });

  // Root endpoint with available routes
  app.get('/', (_req: Request, res: Response) => {
    res.status(200).json({
      message: 'Personal Webhook Server',
      version: '1.0.0',
      availableEndpoints: [
        { path: '/health', method: 'GET', description: 'Health check' },
        ...webhookRoutes.map(route => ({
          path: route.path,
          method: 'POST',
          description: route.description,
        })),
      ],
    });
  });

  // Register all webhook routes
  webhookRoutes.forEach(route => {
    app.post(route.path, route.handler);
    logger.info(`Registered webhook route: POST ${route.path} - ${route.description}`);
  });
};
