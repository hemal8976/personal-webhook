import { Request, Response } from 'express';

/**
 * Generic webhook payload structure
 */
export interface WebhookPayload {
  [key: string]: any;
}

/**
 * Service handler function type
 */
export type ServiceHandler = (req: Request, res: Response) => Promise<void> | void;

/**
 * Fathom AI webhook payload structure
 * Customize this based on actual Fathom webhook data
 */
export interface FathomWebhookPayload extends WebhookPayload {
  event?: string;
  meeting_id?: string;
  title?: string;
  meeting_title?: string;
  share_url?: string;
  summary?: string;
  default_summary?: {
    markdown_formatted?: string;
    template_name?: string;
  };
  recorded_by?: {
    email?: string;
    email_domain?: string;
    name?: string;
    team?: string | null;
  };
  calendar_invitees?: Array<{
    email?: string;
    email_domain?: string;
    name?: string;
    is_external?: boolean;
  }>;
  recording_start_time?: string;
  recording_end_time?: string;
  transcript?: Array<{
    speaker?: {
      display_name?: string;
      matched_calendar_invitee_email?: string | null;
    };
    text?: string;
    timestamp?: string;
  }>;
  action_items?: unknown[];
  timestamp?: string;
  [key: string]: any;
}

/**
 * Webhook route configuration
 */
export interface WebhookRoute {
  path: string;
  handler: ServiceHandler;
  description: string;
}
