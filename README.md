# Personal Webhook Server

A TypeScript-based webhook server for receiving and processing webhooks from various third-party services. Built with Express, Winston logging, and designed for easy extensibility.

## Features

- 🎯 **Type-safe**: Built with TypeScript for better developer experience
- 📝 **Comprehensive Logging**: All requests logged to both console and rotating files
- 🔌 **Extensible**: Easy to add new webhook endpoints
- 🚀 **Hot Reload**: Development server with automatic reload on changes
- 🏥 **Health Checks**: Built-in health check endpoint
- 📊 **Structured Logs**: JSON logs for easy parsing and analysis
- ✅ **ClickUp Integration**: Auto-post Fathom meeting logs to mapped ClickUp tasks

## Prerequisites

- **Node.js**: Version 18.0.0 or higher
- **pnpm**: Fast, efficient package manager
- **ngrok** (optional): For exposing your local server to the internet

## Installation

1. Clone or navigate to the project directory:

```bash
cd personal_webhook
```

2. Install dependencies:

```bash
pnpm install
```

3. Configure environment variables:

```bash
cp .env.example .env
```

Edit `.env` if you want to change default settings:
- `PORT`: Server port (default: 9999)
- `LOG_DIR`: Log files directory (default: logs)
- `LOG_LEVEL`: Logging level (default: info)
- `NODE_ENV`: Environment (development/production)
- `CLICKUP_API_TOKEN`: ClickUp personal API token
- Route-level override: add `clickupApiToken` inside each `CLICKUP_MEETING_ROUTING_JSON` entry to post/comment/create tasks as that project lead account
- `CLICKUP_DEFAULT_TASK_ID`: Fallback task ID when no keyword route matches
- `CLICKUP_MEETING_ROUTING_JSON`: JSON array with keyword routing + per-project task routing (`commentTaskId`, `taskRouting`)
- `CLICKUP_ENABLE_TASK_CREATION`: Global fallback toggle if route-level `taskRouting.enabled` is not set
- `CLICKUP_TASK_CREATION_LIST_ID`: Global fallback list ID if route-level `taskRouting.targetListId` is not set
- `CLICKUP_TASK_DEFAULT_STATUS`: Global fallback status (`backlog` default)
- `CLICKUP_TASK_ASSIGNEE_IDS`: Global fallback comma-separated assignee IDs
- `CLICKUP_TEAM_LEAD_USER_ID`: Backward-compatible single assignee fallback
- `CLICKUP_MAIN_TASK_DESCRIPTION_MAX_CHARS`: Max parent task description length (transcript included)
- `GROQ_API_KEY`: Groq API key for transcript task extraction
- `GROQ_MODEL`: Groq model name (default: `llama-3.3-70b-versatile`)
- `GROQ_MAX_TRANSCRIPT_CHARS`: Max transcript characters sent to Groq (default: 20000)
- `GROQ_TASK_CONFIDENCE_THRESHOLD`: Subtasks are created only for items above threshold (`0.5` default)

## Usage

### Development Mode

Run the server with hot reload:

```bash
pnpm dev
```

The server will start on `http://localhost:9999`

### Production Mode

Build and run:

```bash
pnpm build
pnpm start
```

### Other Commands

- **Type checking**: `pnpm lint`
- **Build only**: `pnpm build`

## Available Endpoints

### Health Check
```bash
GET /health
```

Returns server status and uptime.

### Root
```bash
GET /
```

Returns server info and list of available webhook endpoints.

### Fathom AI Webhook
```bash
POST /fathom
```

Receives webhooks from Fathom AI for meeting transcriptions and summaries.
If ClickUp is configured, it will also post a formatted comment to the matched ClickUp task using:
- Meeting title
- Shareable URL
- Meeting summary (`default_summary.markdown_formatted` or `summary`)

If Groq is configured (`GROQ_API_KEY`), the server extracts action tasks from transcript and:
- logs all extracted items
- creates one parent meeting task in ClickUp (backlog by default) with:
  - title including meeting title + duration
  - formatted call transcript in description
- creates subtasks for items above route-level `taskRouting.confidenceThreshold` (or global fallback `GROQ_TASK_CONFIDENCE_THRESHOLD`)
- uses evidence quote as subtask description

### ClickUp Routing Configuration

Use `CLICKUP_MEETING_ROUTING_JSON` to map meeting titles/attendees to comment target and task/subtask target per project.

Example:

```env
CLICKUP_DEFAULT_TASK_ID=86aDefaultTask
CLICKUP_MEETING_ROUTING_JSON=[{"name":"OpenCables","keywords":["opencables","sunil"],"commentTaskId":"86aCommentTask1","clickupApiToken":"pk_project_lead_token_1","spaceId":"901","folderId":"902","listId":"903","taskRouting":{"enabled":true,"targetSpaceId":"901","targetFolderId":"910","targetListId":"911","defaultStatus":"backlog","assigneeIds":[12345678],"confidenceThreshold":0.5}},{"name":"Client A","keywords":["client a","acme"],"commentTaskId":"86aCommentTask2","clickupApiToken":"pk_project_lead_token_2","spaceId":"901","folderId":"920","listId":"921","taskRouting":{"enabled":true,"targetSpaceId":"901","targetFolderId":"930","targetListId":"931","defaultStatus":"backlog","assigneeIds":[87654321],"confidenceThreshold":0.6}}]
```

Matching checks:
- `meeting_title` / `title`
- `recorded_by` name/email/domain
- `calendar_invitees` name/email/domain

Backward compatibility:
- `taskId` is still accepted as alias for `commentTaskId`.
- Existing global task creation env vars still work as fallback.
- If route-level `clickupApiToken` is missing, global `CLICKUP_API_TOKEN` is used.
- Task creation uses `taskRouting.targetListId` (required for API call). `targetSpaceId` and `targetFolderId` are supported for config clarity/logging.

## Testing Webhooks Locally

### Using curl

Test the Fathom endpoint:

```bash
curl -X POST http://localhost:9999/fathom \
  -H "Content-Type: application/json" \
  -d '{
    "event": "meeting_completed",
    "meeting_id": "test-123",
    "summary": "Test meeting summary",
    "action_items": ["Task 1", "Task 2"]
  }'
```

### Using ngrok

To receive webhooks from external services, expose your local server:

1. Install ngrok:
```bash
brew install ngrok
```

2. Start your webhook server:
```bash
pnpm dev
```

3. In another terminal, start ngrok:
```bash
ngrok http 9999
```

4. Copy the HTTPS URL provided by ngrok (e.g., `https://abc123.ngrok.io`)

5. Configure the webhook URL in your third-party service:
   - For Fathom: Use `https://abc123.ngrok.io/fathom`

## Log Files

Logs are stored in the `logs/` directory:

- `app-YYYY-MM-DD.log`: All application logs (rotated daily, kept for 14 days)
- `error-YYYY-MM-DD.log`: Error logs only (rotated daily, kept for 30 days)
- `combined-YYYY-MM-DD.log`: Combined logs in development mode (kept for 7 days)

All logs are in JSON format for easy parsing.

## Adding New Webhook Endpoints

### Step 1: Create Handler

Create a new file in `src/routes/` (e.g., `slack.ts`):

```typescript
import { Request, Response } from 'express';
import logger from '../logger';

export const slackWebhookHandler = async (req: Request, res: Response): Promise<void> => {
  try {
    const payload = req.body;

    logger.info('Slack webhook received', {
      service: 'slack',
      payload: payload,
      receivedAt: new Date().toISOString(),
    });

    // Add your custom logic here

    res.status(200).json({ success: true });
  } catch (error) {
    logger.error('Error processing Slack webhook', { error });
    res.status(500).json({ error: 'Internal server error' });
  }
};
```

### Step 2: Register Route

Add the new route to `src/routes/index.ts`:

```typescript
import { slackWebhookHandler } from './slack';

const webhookRoutes: WebhookRoute[] = [
  {
    path: '/fathom',
    handler: fathomWebhookHandler,
    description: 'Fathom AI meeting webhook',
  },
  {
    path: '/slack',
    handler: slackWebhookHandler,
    description: 'Slack event webhook',
  },
];
```

### Step 3: Add Types (Optional)

Add payload types to `src/types.ts` for better type safety:

```typescript
export interface SlackWebhookPayload extends WebhookPayload {
  event?: string;
  user?: string;
  channel?: string;
  // ... other Slack-specific fields
}
```

### Step 4: Restart Server

The new endpoint will be available at `POST /slack`

## Project Structure

```
personal_webhook/
├── package.json          # Project dependencies and scripts
├── tsconfig.json        # TypeScript configuration
├── .env                 # Environment variables (not in git)
├── .env.example         # Environment template
├── .gitignore          # Git ignore rules
├── README.md           # This file
├── logs/               # Log files (not in git)
│   └── .gitkeep
└── src/
    ├── index.ts        # Main server entry point
    ├── logger.ts       # Winston logger configuration
    ├── types.ts        # TypeScript type definitions
    ├── middleware/
    │   └── requestLogger.ts  # HTTP request logging
    └── routes/
        ├── index.ts    # Route registration
        └── fathom.ts   # Fathom webhook handler
```

## Security Considerations

- **Webhook Signatures**: Consider adding signature verification for each service
- **Rate Limiting**: Add rate limiting for production use
- **HTTPS**: Use HTTPS in production (ngrok provides this for testing)
- **Authentication**: Add authentication if your webhooks contain sensitive data
- **Input Validation**: Validate webhook payloads before processing

## Future Enhancements

- [ ] Add webhook signature verification per service
- [ ] Add database persistence for webhook history
- [ ] Add retry mechanism for failed actions
- [ ] Add webhook replay capability
- [ ] Add monitoring and alerting
- [ ] Add admin dashboard for viewing webhook history

## Troubleshooting

### Port Already in Use

If port 9999 is already in use, change the `PORT` in `.env` file:

```
PORT=8888
```

### Logs Not Appearing

Check that:
1. The `logs/` directory exists
2. You have write permissions
3. `LOG_DIR` in `.env` points to the correct directory

### Webhooks Not Received

1. Verify the server is running: visit `http://localhost:9999/health`
2. Check ngrok is forwarding correctly
3. Verify the webhook URL in your third-party service
4. Check the logs for any errors

## License

MIT
