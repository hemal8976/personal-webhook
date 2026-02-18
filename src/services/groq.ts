import https from 'node:https';
import { FathomWebhookPayload } from '../types';

export interface ExtractedTaskItem {
  task: string;
  owner: string;
  due_date: string | null;
  priority: 'high' | 'medium' | 'low';
  confidence: number;
  evidence: string;
}

export interface ExtractedTasksResult {
  meeting_summary: string;
  tasks: ExtractedTaskItem[];
}

interface GroqChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
}

const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';
const DEFAULT_MAX_TRANSCRIPT_CHARS = 20000;

const GROQ_SYSTEM_PROMPT = `You are an assistant that extracts actionable tasks from meeting transcripts.

Rules:
1. Transcript may include English + Hindi + Gujarati mixed speech.
2. Return tasks in clear English only.
3. Extract only explicit or strongly implied action items.
4. Do not invent deadlines, owners, or priorities.
5. If owner is unclear, set owner as "Unassigned".
6. If due date is unclear, set due_date as null.
7. Keep each task concise (max 140 chars).
8. Merge duplicates.
9. Ignore small talk, filler, and unrelated noise.
10. Output ONLY valid JSON matching this schema:
{
  "meeting_summary": "string",
  "tasks": [
    {
      "task": "string",
      "owner": "string",
      "due_date": "YYYY-MM-DD or null",
      "priority": "high|medium|low",
      "confidence": 0.0,
      "evidence": "short quote from transcript"
    }
  ]
}`;

const httpRequest = <T>(
  url: string,
  method: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ statusCode: number; data: T }> => {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);

    const request = https.request(
      {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || undefined,
        path: `${parsedUrl.pathname}${parsedUrl.search}`,
        method,
        headers,
      },
      response => {
        let responseBody = '';

        response.on('data', chunk => {
          responseBody += chunk;
        });

        response.on('end', () => {
          const statusCode = response.statusCode ?? 500;

          if (!responseBody) {
            resolve({ statusCode, data: {} as T });
            return;
          }

          try {
            const parsed = JSON.parse(responseBody) as T;
            resolve({ statusCode, data: parsed });
          } catch (_error) {
            reject(new Error(`Failed to parse Groq response JSON: ${responseBody}`));
          }
        });
      },
    );

    request.on('error', error => {
      reject(error);
    });

    if (body) {
      request.write(body);
    }

    request.end();
  });
};

const buildTranscriptText = (payload: FathomWebhookPayload): string => {
  const transcriptEntries = payload.transcript || [];

  if (!Array.isArray(transcriptEntries) || transcriptEntries.length === 0) {
    return '';
  }

  return transcriptEntries
    .map(entry => {
      const timestamp = entry.timestamp || '00:00:00';
      const speaker = entry.speaker?.display_name || 'Unknown';
      const text = entry.text || '';
      return `[${timestamp}] ${speaker}: ${text}`;
    })
    .join('\n');
};

const parseGroqJsonResponse = (rawContent: string): ExtractedTasksResult => {
  const trimmed = rawContent.trim();
  const fencedMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch ? fencedMatch[1] : trimmed;
  const parsed = JSON.parse(candidate) as Partial<ExtractedTasksResult>;

  const meetingSummary = typeof parsed.meeting_summary === 'string' ? parsed.meeting_summary : '';
  const tasks = Array.isArray(parsed.tasks) ? parsed.tasks : [];

  const normalizedTasks: ExtractedTaskItem[] = tasks
    .map(task => {
      const item = task as Partial<ExtractedTaskItem>;
      const priority: ExtractedTaskItem['priority'] =
        item.priority === 'high' || item.priority === 'low' || item.priority === 'medium'
          ? item.priority
          : 'medium';

      return {
        task: typeof item.task === 'string' ? item.task : '',
        owner: typeof item.owner === 'string' ? item.owner : 'Unassigned',
        due_date: typeof item.due_date === 'string' || item.due_date === null ? item.due_date : null,
        priority,
        confidence:
          typeof item.confidence === 'number' && Number.isFinite(item.confidence) ? item.confidence : 0,
        evidence: typeof item.evidence === 'string' ? item.evidence : '',
      };
    })
    .filter(item => item.task.length > 0);

  return {
    meeting_summary: meetingSummary,
    tasks: normalizedTasks,
  };
};

export const extractTasksFromTranscript = async (
  payload: FathomWebhookPayload,
): Promise<ExtractedTasksResult | null> => {
  const groqApiKey = process.env.GROQ_API_KEY?.trim();

  if (!groqApiKey) {
    return null;
  }

  const transcriptText = buildTranscriptText(payload);
  if (!transcriptText) {
    return null;
  }

  const meetingTitle = payload.meeting_title || payload.title || 'Untitled Meeting';
  const participants = [
    payload.recorded_by?.name || '',
    ...(payload.calendar_invitees || []).map(invitee => invitee.name || ''),
  ]
    .filter(Boolean)
    .join(', ');
  const maxTranscriptChars = Number(process.env.GROQ_MAX_TRANSCRIPT_CHARS || DEFAULT_MAX_TRANSCRIPT_CHARS);
  const truncatedTranscript = transcriptText.slice(0, maxTranscriptChars);

  const userPrompt = [
    'Extract action items from this meeting.',
    '',
    `Meeting title: ${meetingTitle}`,
    `Participants: ${participants || 'Unknown'}`,
    '',
    'Transcript:',
    truncatedTranscript,
  ].join('\n');

  const apiBaseUrl = process.env.GROQ_API_BASE_URL || DEFAULT_GROQ_BASE_URL;
  const model = process.env.GROQ_MODEL?.trim() || DEFAULT_GROQ_MODEL;
  const endpoint = `${apiBaseUrl}/chat/completions`;
  const requestBody = JSON.stringify({
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: GROQ_SYSTEM_PROMPT },
      { role: 'user', content: userPrompt },
    ],
  });

  const { statusCode, data } = await httpRequest<GroqChatCompletionResponse>(
    endpoint,
    'POST',
    {
      Authorization: `Bearer ${groqApiKey}`,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(requestBody).toString(),
    },
    requestBody,
  );

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`Groq API error (${statusCode}): ${data.error?.message || 'Unknown error'}`);
  }

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('Groq returned empty content');
  }

  return parseGroqJsonResponse(content);
};

