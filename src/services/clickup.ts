import https from 'node:https';

export interface ClickUpCommentRequest {
  taskId: string;
  commentText?: string;
  comment?: Array<{
    text?: string;
    attributes?: Record<string, unknown>;
    type?: string;
    user?: {
      id: number;
    };
    emoticon?: {
      code: string;
    };
  }>;
  notifyAll?: boolean;
}

export interface ClickUpCommentResponse {
  id?: string;
  date?: string;
  user?: {
    id?: number;
    username?: string;
  };
}

export interface ClickUpCreateTaskRequest {
  listId: string;
  name: string;
  description?: string;
  assignees?: number[];
  status?: string;
  parentTaskId?: string;
}

export interface ClickUpTaskResponse {
  id?: string;
  name?: string;
  status?: {
    status?: string;
  };
}

const DEFAULT_CLICKUP_API_BASE_URL = 'https://api.clickup.com/api/v2';

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
            reject(new Error(`Failed to parse ClickUp response JSON: ${responseBody}`));
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

export const postTaskComment = async (requestPayload: ClickUpCommentRequest): Promise<ClickUpCommentResponse> => {
  const clickUpApiToken = process.env.CLICKUP_API_TOKEN;

  if (!clickUpApiToken) {
    throw new Error('Missing CLICKUP_API_TOKEN environment variable');
  }

  if (!requestPayload.commentText && (!requestPayload.comment || requestPayload.comment.length === 0)) {
    throw new Error('Either commentText or comment must be provided');
  }

  const apiBaseUrl = process.env.CLICKUP_API_BASE_URL || DEFAULT_CLICKUP_API_BASE_URL;
  const endpoint = `${apiBaseUrl}/task/${encodeURIComponent(requestPayload.taskId)}/comment`;
  const requestBody: {
    notify_all: boolean;
    comment_text?: string;
    comment?: ClickUpCommentRequest['comment'];
  } = {
    notify_all: requestPayload.notifyAll ?? false,
  };

  if (requestPayload.comment && requestPayload.comment.length > 0) {
    requestBody.comment = requestPayload.comment;
  } else if (requestPayload.commentText) {
    requestBody.comment_text = requestPayload.commentText;
  }

  const body = JSON.stringify(requestBody);

  const { statusCode, data } = await httpRequest<ClickUpCommentResponse & { err?: string }>(
    endpoint,
    'POST',
    {
      Authorization: clickUpApiToken,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  );

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`ClickUp API error (${statusCode}): ${data.err || 'Unknown error'}`);
  }

  return data;
};

export const createTask = async (requestPayload: ClickUpCreateTaskRequest): Promise<ClickUpTaskResponse> => {
  const clickUpApiToken = process.env.CLICKUP_API_TOKEN;

  if (!clickUpApiToken) {
    throw new Error('Missing CLICKUP_API_TOKEN environment variable');
  }

  const apiBaseUrl = process.env.CLICKUP_API_BASE_URL || DEFAULT_CLICKUP_API_BASE_URL;
  const endpoint = `${apiBaseUrl}/list/${encodeURIComponent(requestPayload.listId)}/task`;
  const requestBody: {
    name: string;
    description?: string;
    assignees?: number[];
    status?: string;
    parent?: string;
  } = {
    name: requestPayload.name,
  };

  if (requestPayload.description) {
    requestBody.description = requestPayload.description;
  }

  if (requestPayload.assignees && requestPayload.assignees.length > 0) {
    requestBody.assignees = requestPayload.assignees;
  }

  if (requestPayload.status) {
    requestBody.status = requestPayload.status;
  }

  if (requestPayload.parentTaskId) {
    requestBody.parent = requestPayload.parentTaskId;
  }

  const body = JSON.stringify(requestBody);

  const { statusCode, data } = await httpRequest<ClickUpTaskResponse & { err?: string }>(
    endpoint,
    'POST',
    {
      Authorization: clickUpApiToken,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body).toString(),
    },
    body,
  );

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error(`ClickUp API error (${statusCode}): ${data.err || 'Unknown error'}`);
  }

  return data;
};
