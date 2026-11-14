import {
  type IDataObject,
  type IHookFunctions,
  type IHttpRequestOptions,
  type INodeType,
  type INodeTypeDescription,
  type IWebhookFunctions,
  type IWebhookResponseData,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';
import { apiBase, EVENTS } from '../../shared/requests.ts';
import { type HeaderBag, verifySignature } from '../../shared/signature.ts';
import { type Registration, registerWebhook, unregisterWebhook, webhookExists } from '../../shared/trigger.ts';

const CREDENTIAL = 'vid2contextApi';

const EVENT_LABELS: Record<(typeof EVENTS)[number], { name: string; description: string }> = {
  'video.ingested': { name: 'Video Ingested', description: 'A video was fetched and saved to the library' },
  'collection.updated': {
    name: 'Collection Updated',
    description: 'A collection gained or lost videos (a watch list found new uploads)',
  },
  'job.succeeded': { name: 'Job Succeeded', description: 'A background job finished' },
  'job.failed': { name: 'Job Failed', description: 'A background job failed' },
  'brief.ready': { name: 'Brief Ready', description: 'A cited brief over one or more videos is ready' },
};

async function context(fn: IHookFunctions) {
  const credentials = await fn.getCredentials(CREDENTIAL);
  const base = apiBase(String(credentials.baseUrl ?? ''));
  const request = (options: IHttpRequestOptions) => fn.helpers.httpRequestWithAuthentication.call(fn, CREDENTIAL, options);
  return { base, request };
}

export class Vid2ContextTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'vid2context Trigger',
    name: 'vid2contextTrigger',
    icon: 'file:vid2context.svg',
    group: ['trigger'],
    version: 1,
    subtitle: '={{$parameter["events"].join(", ")}}',
    description: 'Starts the workflow on vid2context events: new videos, collection updates, finished jobs and briefs',
    defaults: { name: 'vid2context Trigger' },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    webhooks: [{ name: 'default', httpMethod: 'POST', responseMode: 'onReceived', path: 'webhook' }],
    properties: [
      {
        displayName: 'Events',
        name: 'events',
        type: 'multiOptions',
        required: true,
        default: ['collection.updated'],
        options: EVENTS.map((e) => ({ value: e, ...EVENT_LABELS[e] })),
        description: 'The events that start this workflow',
      },
      {
        displayName:
          'vid2context must be able to reach this n8n webhook URL. For n8n on localhost or your private network, set VID2CONTEXT_WEBHOOKS_ALLOW_LOCAL=1 on the vid2context server.',
        name: 'notice',
        type: 'notice',
        default: '',
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node') as Partial<Registration>;
        const { base, request } = await context(this);
        const exists = await webhookExists(request, base, { ...data, url: this.getNodeWebhookUrl('default') });
        if (!exists) {
          delete data.webhookId;
          delete data.secret;
          delete data.url;
        }
        return exists;
      },

      async create(this: IHookFunctions): Promise<boolean> {
        const url = this.getNodeWebhookUrl('default');
        if (!url) throw new NodeOperationError(this.getNode(), 'n8n did not provide a webhook URL for this trigger.');
        const events = this.getNodeParameter('events', []) as string[];
        const { base, request } = await context(this);
        const reg = await registerWebhook(request, base, {
          url,
          events,
          description: `n8n workflow ${this.getWorkflow().id ?? ''}`.trim(),
        });
        Object.assign(this.getWorkflowStaticData('node'), reg);
        return true;
      },

      async delete(this: IHookFunctions): Promise<boolean> {
        const data = this.getWorkflowStaticData('node') as Partial<Registration>;
        if (data.webhookId) {
          const { base, request } = await context(this);
          await unregisterWebhook(request, base, data.webhookId);
        }
        delete data.webhookId;
        delete data.secret;
        delete data.url;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    const data = this.getWorkflowStaticData('node') as Partial<Registration>;
    const req = this.getRequestObject() as ReturnType<IWebhookFunctions['getRequestObject']> & { rawBody?: Buffer };
    const res = this.getResponseObject();
    const headers = this.getHeaderData() as HeaderBag;
    // n8n keeps the raw bytes on the request; signatures must be checked against them, not re-serialized JSON.
    const raw = req.rawBody ?? Buffer.from(JSON.stringify(this.getBodyData()));
    let payload: IDataObject;
    try {
      if (!data.secret)
        throw new Error('This trigger has no signing secret; deactivate and activate the workflow to register again.');
      payload = verifySignature(data.secret, headers, raw) as IDataObject;
    } catch (error) {
      res.status(401).json({ error: (error as Error).message });
      return { noWebhookResponse: true };
    }
    return {
      workflowData: [
        [
          {
            json: {
              ...payload,
              messageId: String(headers['webhook-id'] ?? ''),
            },
          },
        ],
      ],
    };
  }
}
