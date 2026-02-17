import { Request, Response } from 'express';
import logger from '../logger';
import { FathomWebhookPayload } from '../types';
import { postTaskComment } from '../services/clickup';

interface ClickUpMeetingRoute {
  name: string;
  keywords: string[];
  taskId: string;
  spaceId?: string;
  folderId?: string;
  listId?: string;
}

interface ResolvedMeetingRoute extends ClickUpMeetingRoute {
  matchedKeywords: string[];
}

const parseMeetingRoutes = (): ClickUpMeetingRoute[] => {
  const rawRoutes = process.env.CLICKUP_MEETING_ROUTING_JSON;

  if (!rawRoutes) {
    return [];
  }

  try {
    const parsed = JSON.parse(rawRoutes) as unknown;

    if (!Array.isArray(parsed)) {
      logger.warn('CLICKUP_MEETING_ROUTING_JSON must be a JSON array');
      return [];
    }

    const mappedRoutes = parsed.map((route, index): ClickUpMeetingRoute | null => {
      if (!route || typeof route !== 'object') {
        logger.warn('Invalid ClickUp route entry, skipping', { index });
        return null;
      }

      const candidate = route as Record<string, unknown>;
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : '';
      const taskId = typeof candidate.taskId === 'string' ? candidate.taskId.trim() : '';
      const keywords = Array.isArray(candidate.keywords)
        ? candidate.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
        : [];

      if (!name || !taskId || keywords.length === 0) {
        logger.warn('ClickUp route is missing required fields, skipping', {
          index,
          required: ['name', 'taskId', 'keywords'],
        });
        return null;
      }

      const spaceId = typeof candidate.spaceId === 'string' ? candidate.spaceId : undefined;
      const folderId = typeof candidate.folderId === 'string' ? candidate.folderId : undefined;
      const listId = typeof candidate.listId === 'string' ? candidate.listId : undefined;

      return { name, taskId, keywords, spaceId, folderId, listId };
    });

    return mappedRoutes.filter((route): route is ClickUpMeetingRoute => route !== null);
  } catch (error) {
    logger.error('Invalid CLICKUP_MEETING_ROUTING_JSON', {
      error: error instanceof Error ? error.message : 'Unknown parse error',
    });
    return [];
  }
};

const normalize = (value: string): string => value.toLowerCase().trim();

const formatMeetingDate = (payload: FathomWebhookPayload): string => {
  const rawDate =
    payload.recording_start_time ||
    payload.scheduled_start_time ||
    payload.created_at ||
    payload.timestamp;

  if (!rawDate) {
    return 'N/A';
  }

  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())) {
    return 'N/A';
  }

  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const year = date.getFullYear();

  return `${day}-${month}-${year}`;
};

const getSummaryText = (payload: FathomWebhookPayload): string => {
  if (payload.default_summary?.markdown_formatted) {
    return payload.default_summary.markdown_formatted.trim();
  }

  if (typeof payload.summary === 'string' && payload.summary.trim().length > 0) {
    return payload.summary.trim();
  }

  return 'No summary provided by Fathom.';
};

const resolveClickUpRoute = (payload: FathomWebhookPayload): ResolvedMeetingRoute | null => {
  const meetingRoutes = parseMeetingRoutes();
  const fallbackTaskId = process.env.CLICKUP_DEFAULT_TASK_ID?.trim();
  const meetingTitle = (payload.meeting_title || payload.title || '').trim();

  if (meetingRoutes.length === 0 && !fallbackTaskId) {
    return null;
  }

  const matchingFields = [
    meetingTitle,
    payload.recorded_by?.name || '',
    payload.recorded_by?.email || '',
    payload.recorded_by?.email_domain || '',
    ...(payload.calendar_invitees || []).flatMap(invitee => [
      invitee.name || '',
      invitee.email || '',
      invitee.email_domain || '',
    ]),
  ]
    .map(normalize)
    .filter(Boolean);

  const scoredRoutes = meetingRoutes
    .map(route => {
      const matchedKeywords = route.keywords
        .map(normalize)
        .filter(keyword => matchingFields.some(field => field.includes(keyword)));

      return {
        route,
        matchedKeywords,
        score: matchedKeywords.length,
      };
    })
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredRoutes.length > 0) {
    const bestMatch = scoredRoutes[0];
    return {
      ...bestMatch.route,
      matchedKeywords: bestMatch.matchedKeywords,
    };
  }

  if (fallbackTaskId) {
    return {
      name: 'default',
      taskId: fallbackTaskId,
      keywords: [],
      matchedKeywords: [],
    };
  }

  return null;
};

const buildClickUpComment = (payload: FathomWebhookPayload): string => {
  const meetingTitle = payload.meeting_title || payload.title || 'Untitled Meeting';
  const shareUrl = payload.share_url || payload.url || 'N/A';
  const meetingDate = formatMeetingDate(payload);
  const summary = getSummaryText(payload);

  return [
    `${meetingTitle} ${meetingDate} : ${shareUrl}.`,
    '\nKindly check summary as below:\n',
    summary,
  ].join('\n');
};

const unescapeMarkdown = (value: string): string => {
  return value.replace(/\\([\\`*_{}\[\]()#+\-.!&])/g, '$1');
};

const markdownToClickUpComment = (
  markdown: string,
): Array<{ text: string; attributes: Record<string, unknown> }> => {
  const lines = markdown.split('\n');
  const blocks: Array<{ text: string; attributes: Record<string, unknown> }> = [];

  lines.forEach((line, lineIndex) => {
    let workingLine = unescapeMarkdown(line);
    let defaultAttributes: Record<string, unknown> = {};

    // Map markdown headings to bold text in ClickUp comment blocks.
    if (/^#{1,6}\s+/.test(workingLine)) {
      workingLine = workingLine.replace(/^#{1,6}\s+/, '');
      defaultAttributes = { bold: true };
    }

    const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null = linkRegex.exec(workingLine);

    while (match) {
      if (match.index > lastIndex) {
        blocks.push({
          text: workingLine.slice(lastIndex, match.index),
          attributes: defaultAttributes,
        });
      }

      blocks.push({
        text: match[1],
        attributes: {
          ...defaultAttributes,
          link: match[2],
        },
      });

      lastIndex = match.index + match[0].length;
      match = linkRegex.exec(workingLine);
    }

    if (lastIndex < workingLine.length || workingLine.length === 0) {
      blocks.push({
        text: workingLine.slice(lastIndex),
        attributes: defaultAttributes,
      });
    }

    if (lineIndex < lines.length - 1) {
      blocks.push({ text: '\n', attributes: {} });
    }
  });

  return blocks;
};

/**
 * Handler for Fathom AI webhooks
 * Receives webhook data, logs it, and can be extended with custom actions
 */
export const fathomWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload: FathomWebhookPayload = req.body;
    const meetingTitle = payload.meeting_title || payload.title || 'Untitled Meeting';

    // Log the webhook data with service context
    logger.info('Fathom webhook received', {
      service: 'fathom',
      event: payload.event || 'unknown',
      meetingTitle,
      shareUrl: payload.share_url || payload.url || null,
      receivedAt: new Date().toISOString(),
    });

    // Basic validation
    if (!payload || Object.keys(payload).length === 0) {
      logger.warn('Empty Fathom webhook payload received');
      res.status(400).json({ error: 'Empty payload' });
      return;
    }

    const resolvedRoute = resolveClickUpRoute(payload);

    if (!resolvedRoute) {
      logger.warn('No ClickUp route matched for meeting', {
        meetingTitle,
      });

      res.status(202).json({
        success: true,
        postedToClickUp: false,
        message: 'Webhook received but no ClickUp mapping matched this meeting',
        meetingTitle,
      });
      return;
    }

    const commentText = buildClickUpComment(payload);
    const formattedComment = markdownToClickUpComment(commentText);
    const clickUpComment = await postTaskComment({
      taskId: resolvedRoute.taskId,
      comment: formattedComment,
      notifyAll: false,
    });

    logger.info('Posted Fathom meeting to ClickUp task', {
      meetingTitle,
      taskId: resolvedRoute.taskId,
      routeName: resolvedRoute.name,
      matchedKeywords: resolvedRoute.matchedKeywords,
      clickUpCommentId: clickUpComment.id || null,
      spaceId: resolvedRoute.spaceId || null,
      folderId: resolvedRoute.folderId || null,
      listId: resolvedRoute.listId || null,
    });

    // Acknowledge receipt
    res.status(200).json({
      success: true,
      postedToClickUp: true,
      route: {
        name: resolvedRoute.name,
        taskId: resolvedRoute.taskId,
        matchedKeywords: resolvedRoute.matchedKeywords,
      },
      clickUpCommentId: clickUpComment.id || null,
      message: 'Webhook received and ClickUp comment added',
      receivedAt: new Date().toISOString(),
    });
  } catch (error) {
    logger.error('Error processing Fathom webhook', {
      error: error instanceof Error ? error.message : 'Unknown error',
      stack: error instanceof Error ? error.stack : undefined,
    });

    res.status(500).json({
      success: false,
      error: 'Internal server error',
    });
  }
};
