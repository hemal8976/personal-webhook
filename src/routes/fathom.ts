import { Request, Response } from 'express';
import logger from '../logger';
import { FathomWebhookPayload } from '../types';
import { createTask, postTaskComment } from '../services/clickup';
import { extractTasksFromTranscript, ExtractedTasksResult } from '../services/groq';

interface ClickUpMeetingRoute {
  name: string;
  keywords: string[];
  commentTaskId: string;
  clickupApiToken?: string;
  spaceId?: string;
  folderId?: string;
  listId?: string;
  taskRouting?: {
    enabled?: boolean;
    targetSpaceId?: string;
    targetFolderId?: string;
    targetListId?: string;
    defaultStatus?: string;
    assigneeIds?: number[];
    confidenceThreshold?: number;
  };
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
      const commentTaskId = typeof candidate.commentTaskId === 'string'
        ? candidate.commentTaskId.trim()
        : typeof candidate.taskId === 'string'
          ? candidate.taskId.trim()
          : '';
      const keywords = Array.isArray(candidate.keywords)
        ? candidate.keywords.filter((keyword): keyword is string => typeof keyword === 'string')
        : [];

      if (!name || !commentTaskId || keywords.length === 0) {
        logger.warn('ClickUp route is missing required fields, skipping', {
          index,
          required: ['name', 'commentTaskId (or taskId)', 'keywords'],
        });
        return null;
      }

      const spaceId = typeof candidate.spaceId === 'string' ? candidate.spaceId : undefined;
      const folderId = typeof candidate.folderId === 'string' ? candidate.folderId : undefined;
      const listId = typeof candidate.listId === 'string' ? candidate.listId : undefined;
      const clickupApiToken =
        typeof candidate.clickupApiToken === 'string' ? candidate.clickupApiToken.trim() : undefined;
      const rawTaskRouting = candidate.taskRouting;
      const taskRouting =
        rawTaskRouting && typeof rawTaskRouting === 'object'
          ? {
              enabled:
                typeof (rawTaskRouting as Record<string, unknown>).enabled === 'boolean'
                  ? ((rawTaskRouting as Record<string, unknown>).enabled as boolean)
                  : undefined,
              targetListId:
                typeof (rawTaskRouting as Record<string, unknown>).targetListId === 'string'
                  ? ((rawTaskRouting as Record<string, unknown>).targetListId as string)
                  : undefined,
              targetSpaceId:
                typeof (rawTaskRouting as Record<string, unknown>).targetSpaceId === 'string'
                  ? ((rawTaskRouting as Record<string, unknown>).targetSpaceId as string)
                  : undefined,
              targetFolderId:
                typeof (rawTaskRouting as Record<string, unknown>).targetFolderId === 'string'
                  ? ((rawTaskRouting as Record<string, unknown>).targetFolderId as string)
                  : undefined,
              defaultStatus:
                typeof (rawTaskRouting as Record<string, unknown>).defaultStatus === 'string'
                  ? ((rawTaskRouting as Record<string, unknown>).defaultStatus as string)
                  : undefined,
              assigneeIds: Array.isArray((rawTaskRouting as Record<string, unknown>).assigneeIds)
                ? ((rawTaskRouting as Record<string, unknown>).assigneeIds as unknown[])
                    .map(value => Number(value))
                    .filter(value => Number.isInteger(value) && value > 0)
                : undefined,
              confidenceThreshold:
                typeof (rawTaskRouting as Record<string, unknown>).confidenceThreshold === 'number'
                  ? ((rawTaskRouting as Record<string, unknown>).confidenceThreshold as number)
                  : undefined,
            }
          : undefined;

      return { name, commentTaskId, clickupApiToken, keywords, spaceId, folderId, listId, taskRouting };
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

const parseIsoDate = (value?: string): Date | null => {
  if (!value) {
    return null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const getMeetingDurationSeconds = (payload: FathomWebhookPayload): number | null => {
  const recordingStart = parseIsoDate(payload.recording_start_time);
  const recordingEnd = parseIsoDate(payload.recording_end_time);
  const scheduledStart = parseIsoDate(payload.scheduled_start_time);
  const scheduledEnd = parseIsoDate(payload.scheduled_end_time);

  const start = recordingStart || scheduledStart;
  const end = recordingEnd || scheduledEnd;

  if (!start || !end) {
    return null;
  }

  const duration = Math.floor((end.getTime() - start.getTime()) / 1000);
  return duration > 0 ? duration : null;
};

const formatMeetingDuration = (payload: FathomWebhookPayload): string => {
  const durationSeconds = getMeetingDurationSeconds(payload);

  if (!durationSeconds) {
    return 'N/A';
  }

  const hours = Math.floor(durationSeconds / 3600);
  const minutes = Math.floor((durationSeconds % 3600) / 60);

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}h ${String(minutes).padStart(2, '0')}m`;
  }

  return `${String(minutes).padStart(2, '0')}m`;
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

const parseAssigneeIdsFromRaw = (rawIds: string): number[] => {
  if (!rawIds.trim()) {
    return [];
  }

  return rawIds
    .split(',')
    .map(value => Number(value.trim()))
    .filter(value => Number.isInteger(value) && value > 0);
};

const parseGlobalAssigneeIds = (): number[] => {
  const rawIds = process.env.CLICKUP_TASK_ASSIGNEE_IDS || process.env.CLICKUP_TEAM_LEAD_USER_ID || '';
  return parseAssigneeIdsFromRaw(rawIds);
};

const parseGlobalConfidenceThreshold = (): number => {
  const rawThreshold = Number(process.env.GROQ_TASK_CONFIDENCE_THRESHOLD || '0.5');

  if (!Number.isFinite(rawThreshold)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, rawThreshold));
};

const resolveTaskCreationListId = (route: ResolvedMeetingRoute): string | null => {
  const configuredListId = process.env.CLICKUP_TASK_CREATION_LIST_ID?.trim();
  return route.taskRouting?.targetListId?.trim() || route.listId || configuredListId || null;
};

const resolveTaskSpaceIdForRoute = (route: ResolvedMeetingRoute): string | null => {
  return route.taskRouting?.targetSpaceId?.trim() || route.spaceId || null;
};

const resolveTaskFolderIdForRoute = (route: ResolvedMeetingRoute): string | null => {
  return route.taskRouting?.targetFolderId?.trim() || route.folderId || null;
};

const isGlobalTaskCreationEnabled = (): boolean => {
  const flag = (process.env.CLICKUP_ENABLE_TASK_CREATION || 'true').toLowerCase().trim();
  return !['false', '0', 'no', 'off'].includes(flag);
};

const isTaskCreationEnabledForRoute = (route: ResolvedMeetingRoute): boolean => {
  if (typeof route.taskRouting?.enabled === 'boolean') {
    return route.taskRouting.enabled;
  }
  return isGlobalTaskCreationEnabled();
};

const resolveTaskStatusForRoute = (route: ResolvedMeetingRoute): string => {
  const routeStatus = route.taskRouting?.defaultStatus?.trim();
  if (routeStatus) {
    return routeStatus;
  }
  return (process.env.CLICKUP_TASK_DEFAULT_STATUS || 'backlog').trim();
};

const resolveAssigneeIdsForRoute = (route: ResolvedMeetingRoute): number[] => {
  if (route.taskRouting?.assigneeIds && route.taskRouting.assigneeIds.length > 0) {
    return route.taskRouting.assigneeIds;
  }
  return parseGlobalAssigneeIds();
};

const resolveConfidenceThresholdForRoute = (route: ResolvedMeetingRoute): number => {
  if (typeof route.taskRouting?.confidenceThreshold === 'number' && Number.isFinite(route.taskRouting.confidenceThreshold)) {
    return Math.max(0, Math.min(1, route.taskRouting.confidenceThreshold));
  }
  return parseGlobalConfidenceThreshold();
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
      commentTaskId: fallbackTaskId,
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

const buildMainMeetingTaskName = (payload: FathomWebhookPayload): string => {
  const meetingDate = formatMeetingDate(payload);
  const meetingTitle = payload.meeting_title || payload.title || 'Untitled Meeting';
  const meetingDuration = formatMeetingDuration(payload);
  return `${meetingDate} - Meeting discussed tasks | Title: ${meetingTitle} | Duration: ${meetingDuration}`;
};

const buildTranscriptTextForDescription = (payload: FathomWebhookPayload): string => {
  const transcriptEntries = payload.transcript || [];

  if (!Array.isArray(transcriptEntries) || transcriptEntries.length === 0) {
    return 'Transcript not available.';
  }

  const lines = transcriptEntries.map(entry => {
    const timestamp = entry.timestamp || '00:00:00';
    const speaker = entry.speaker?.display_name || 'Unknown';
    const text = (entry.text || '').trim();
    return `[${timestamp}] ${speaker}: ${text}`;
  });

  return lines.join('\n');
};

const buildMainTaskDescription = (payload: FathomWebhookPayload, extractedCount: number): string => {
  const meetingTitle = payload.meeting_title || payload.title || 'Untitled Meeting';
  const meetingDate = formatMeetingDate(payload);
  const meetingDuration = formatMeetingDuration(payload);
  const shareUrl = payload.share_url || payload.url || 'N/A';
  const transcriptText = buildTranscriptTextForDescription(payload);

  const description = [
    'Auto-created from Fathom meeting transcript.',
    `Meeting title: ${meetingTitle}`,
    `Meeting date: ${meetingDate}`,
    `Meeting duration: ${meetingDuration}`,
    `Meeting link: ${shareUrl}`,
    `Total extracted task items: ${extractedCount}`,
    '',
    'Call Transcript:',
    transcriptText,
  ].join('\n');

  const maxChars = Number(process.env.CLICKUP_MAIN_TASK_DESCRIPTION_MAX_CHARS || '50000');
  if (!Number.isFinite(maxChars) || maxChars <= 0 || description.length <= maxChars) {
    return description;
  }

  const ellipsis = '\n\n[Transcript truncated due to length]';
  return `${description.slice(0, Math.max(0, maxChars - ellipsis.length))}${ellipsis}`;
};

const buildSubtaskDescription = (evidence: string, confidence: number): string => {
  const formattedConfidence = confidence.toFixed(2);
  const evidenceLine = evidence.trim() ? evidence.trim() : 'No evidence snippet provided.';
  return `Evidence: ${evidenceLine}\nConfidence: ${formattedConfidence}`;
};

const createMeetingTasksInClickUp = async (
  payload: FathomWebhookPayload,
  route: ResolvedMeetingRoute,
  extracted: ExtractedTasksResult,
): Promise<{
  mainTaskId: string | null;
  createdSubtasksCount: number;
  eligibleSubtasksCount: number;
}> => {
  if (!isTaskCreationEnabledForRoute(route)) {
    return { mainTaskId: null, createdSubtasksCount: 0, eligibleSubtasksCount: 0 };
  }

  const listId = resolveTaskCreationListId(route);
  if (!listId) {
    logger.warn('Task creation skipped because listId is not configured', {
      routeName: route.name,
      routeSpaceId: route.spaceId || null,
      routeListId: route.listId || null,
      taskRoutingSpaceId: route.taskRouting?.targetSpaceId || null,
      taskRoutingFolderId: route.taskRouting?.targetFolderId || null,
      taskRoutingListId: route.taskRouting?.targetListId || null,
      configuredListId: process.env.CLICKUP_TASK_CREATION_LIST_ID || null,
    });
    return { mainTaskId: null, createdSubtasksCount: 0, eligibleSubtasksCount: 0 };
  }

  const assignees = resolveAssigneeIdsForRoute(route);
  const taskStatus = resolveTaskStatusForRoute(route);
  const selectedTasks = extracted.tasks;
  const taskSpaceId = resolveTaskSpaceIdForRoute(route);
  const taskFolderId = resolveTaskFolderIdForRoute(route);

  const parentTask = await createTask({
    apiToken: route.clickupApiToken,
    listId,
    name: buildMainMeetingTaskName(payload),
    description: buildMainTaskDescription(payload, extracted.tasks.length),
    assignees,
    status: taskStatus,
  });

  const parentTaskId = parentTask.id || null;
  if (!parentTaskId) {
    throw new Error('ClickUp did not return parent task id');
  }

  let createdSubtasksCount = 0;
  for (const taskItem of selectedTasks) {
    try {
      await createTask({
        apiToken: route.clickupApiToken,
        listId,
        parentTaskId,
        name: taskItem.task,
        description: buildSubtaskDescription(taskItem.evidence, taskItem.confidence),
        assignees,
        status: taskStatus,
      });
      createdSubtasksCount += 1;
    } catch (error) {
      logger.error('Failed to create ClickUp subtask', {
        parentTaskId,
        taskSpaceId,
        taskFolderId,
        taskListId: listId,
        subtaskName: taskItem.task,
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  return {
    mainTaskId: parentTaskId,
    createdSubtasksCount,
    eligibleSubtasksCount: selectedTasks.length,
  };
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
      apiToken: resolvedRoute.clickupApiToken,
      taskId: resolvedRoute.commentTaskId,
      comment: formattedComment,
      notifyAll: false,
    });

    logger.info('Posted Fathom meeting to ClickUp task', {
      meetingTitle,
      commentTaskId: resolvedRoute.commentTaskId,
      usingRouteToken: Boolean(resolvedRoute.clickupApiToken),
      routeName: resolvedRoute.name,
      matchedKeywords: resolvedRoute.matchedKeywords,
      clickUpCommentId: clickUpComment.id || null,
      spaceId: resolvedRoute.spaceId || null,
      folderId: resolvedRoute.folderId || null,
      listId: resolvedRoute.listId || null,
      taskRouting: resolvedRoute.taskRouting || null,
    });

    let extractedTasksCount = 0;
    let createdMainTaskId: string | null = null;
    let createdSubtasksCount = 0;
    let eligibleSubtasksCount = 0;
    let extracted: ExtractedTasksResult | null = null;
    let groqExtractionFailed = false;

    try {
      extracted = await extractTasksFromTranscript(payload);
    } catch (groqError) {
      groqExtractionFailed = true;
      logger.error('Groq task extraction failed', {
        meetingTitle,
        error: groqError instanceof Error ? groqError.message : 'Unknown error',
      });
    }

    if (extracted) {
      extractedTasksCount = extracted.tasks.length;
      logger.info('Groq extracted tasks from meeting transcript', {
        meetingTitle,
        taskCount: extracted.tasks.length,
        tasks: extracted.tasks,
        summary: extracted.meeting_summary,
      });

      try {
        const taskCreationResult = await createMeetingTasksInClickUp(payload, resolvedRoute, extracted);
        createdMainTaskId = taskCreationResult.mainTaskId;
        createdSubtasksCount = taskCreationResult.createdSubtasksCount;
        eligibleSubtasksCount = taskCreationResult.eligibleSubtasksCount;

        logger.info('ClickUp task creation summary', {
          meetingTitle,
          createdMainTaskId,
          createdSubtasksCount,
          eligibleSubtasksCount,
          confidenceThreshold: resolveConfidenceThresholdForRoute(resolvedRoute),
          taskSpaceId: resolveTaskSpaceIdForRoute(resolvedRoute),
          taskFolderId: resolveTaskFolderIdForRoute(resolvedRoute),
          taskListId: resolveTaskCreationListId(resolvedRoute),
        });
      } catch (taskCreationError) {
        logger.error('ClickUp task creation failed', {
          meetingTitle,
          routeName: resolvedRoute.name,
          commentTaskId: resolvedRoute.commentTaskId,
          taskSpaceId: resolveTaskSpaceIdForRoute(resolvedRoute),
          taskFolderId: resolveTaskFolderIdForRoute(resolvedRoute),
          taskListId: resolveTaskCreationListId(resolvedRoute),
          error: taskCreationError instanceof Error ? taskCreationError.message : 'Unknown error',
        });
      }
    } else {
      logger.info('Groq task extraction skipped', {
        meetingTitle,
        reason: groqExtractionFailed ? 'Groq extraction failed' : 'Missing GROQ_API_KEY or transcript',
      });
    }

    // Acknowledge receipt
    res.status(200).json({
      success: true,
      postedToClickUp: true,
      route: {
        name: resolvedRoute.name,
        taskId: resolvedRoute.commentTaskId,
        matchedKeywords: resolvedRoute.matchedKeywords,
      },
      clickUpCommentId: clickUpComment.id || null,
      extractedTasksCount,
      createdMainTaskId,
      eligibleSubtasksCount,
      createdSubtasksCount,
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
