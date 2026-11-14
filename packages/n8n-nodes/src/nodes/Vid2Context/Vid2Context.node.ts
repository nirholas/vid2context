import {
  type IDataObject,
  type IExecuteFunctions,
  type IHttpRequestOptions,
  type ILoadOptionsFunctions,
  type INodeExecutionData,
  type INodePropertyOptions,
  type INodeType,
  type INodeTypeDescription,
  type JsonObject,
  NodeApiError,
  NodeConnectionTypes,
  NodeOperationError,
} from 'n8n-workflow';
import {
  addToCollectionRequest,
  apiBase,
  apiErrorMessage,
  contextRequest,
  type FullResponse,
  healthRequest,
  isMissingRoute,
  itemsRequest,
  listCollectionsRequest,
  MODES,
  metadataRequest,
  parseInputs,
  type TranscriptParams,
  transcriptItem,
  transcriptRequest,
} from '../../shared/requests.ts';

const CREDENTIAL = 'vid2contextApi';

async function baseUrl(fn: IExecuteFunctions | ILoadOptionsFunctions): Promise<string> {
  const credentials = await fn.getCredentials(CREDENTIAL);
  return apiBase(String(credentials.baseUrl ?? ''));
}

export class Vid2Context implements INodeType {
  description: INodeTypeDescription = {
    displayName: 'vid2context',
    name: 'vid2context',
    icon: 'file:vid2context.svg',
    group: ['transform'],
    version: 1,
    subtitle: '={{$parameter["operation"]}}',
    description: 'Turn a video into context for AI: transcript, metadata, chapters',
    defaults: { name: 'vid2context' },
    usableAsTool: true,
    inputs: [NodeConnectionTypes.Main],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: CREDENTIAL, required: true }],
    properties: [
      {
        displayName: 'Operation',
        name: 'operation',
        type: 'options',
        noDataExpression: true,
        options: [
          {
            name: 'Get Transcript',
            value: 'getTranscript',
            action: 'Get the transcript of a video',
            description: 'The transcript rendered in a format such as text or JSON',
          },
          {
            name: 'Get Metadata',
            value: 'getMetadata',
            action: 'Get the metadata of a video',
            description: 'Title, channel, description, duration, chapters and tags',
          },
          {
            name: 'Get Context',
            value: 'getContext',
            action: 'Get the full context of a video',
            description: 'Metadata, timed transcript segments and how they were obtained',
          },
          {
            name: 'List Items',
            value: 'listItems',
            action: 'List the videos in a playlist channel or feed',
            description: 'Expand a playlist, channel, podcast feed or page into one item per video',
          },
          {
            name: 'Add to Collection',
            value: 'addToCollection',
            action: 'Add videos to a collection',
            description: 'Fetch videos (or every video of a playlist or feed) and save them into a collection',
          },
        ],
        default: 'getTranscript',
      },
      {
        displayName: 'Video URL',
        name: 'url',
        type: 'string',
        required: true,
        default: '',
        placeholder: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        description:
          'A video URL or ID that vid2context understands (YouTube, podcasts, files on the server). For List Items: a playlist, channel or feed URL.',
        displayOptions: { hide: { operation: ['addToCollection'] } },
      },
      {
        displayName: 'Collection Name or ID',
        name: 'collectionId',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getCollections' },
        required: true,
        default: '',
        description:
          'The collection to add to. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { operation: ['addToCollection'] } },
      },
      {
        displayName: 'Videos',
        name: 'inputs',
        type: 'string',
        typeOptions: { rows: 3 },
        required: true,
        default: '',
        placeholder: 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
        description:
          'Video, playlist, channel or feed URLs, one per line or separated by commas. Playlists and feeds add every video the collection has not seen.',
        displayOptions: { show: { operation: ['addToCollection'] } },
      },
      {
        displayName: 'Max New Videos',
        name: 'maxNew',
        type: 'number',
        typeOptions: { minValue: 0 },
        default: 0,
        description: 'Most new videos to fetch in this run; 0 uses the server limit (VID2CONTEXT_MAX_PLAYLIST_ITEMS)',
        displayOptions: { show: { operation: ['addToCollection'] } },
      },
      {
        displayName: 'Limit',
        name: 'limit',
        type: 'number',
        typeOptions: { minValue: 1 },
        default: 50,
        description: 'Max number of results to return',
        displayOptions: { show: { operation: ['listItems'] } },
      },
      {
        displayName: 'Format Name or ID',
        name: 'format',
        type: 'options',
        typeOptions: { loadOptionsMethod: 'getFormats' },
        default: 'text',
        description:
          'Output format, as listed by the server. Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>.',
        displayOptions: { show: { operation: ['getTranscript'] } },
      },
      {
        displayName: 'Timestamps',
        name: 'timestamps',
        type: 'boolean',
        default: false,
        description: 'Whether to prefix lines with timestamps where the format allows it',
        displayOptions: { show: { operation: ['getTranscript'] } },
      },
      {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        displayOptions: { hide: { operation: ['addToCollection'] } },
        options: [
          {
            displayName: 'Mode',
            name: 'mode',
            type: 'options',
            options: MODES.map((m) => ({ name: m, value: m })),
            default: 'auto',
            description: 'Auto uses captions and falls back to speech-to-text; captions never downloads audio',
          },
          {
            displayName: 'Language',
            name: 'lang',
            type: 'string',
            default: '',
            placeholder: 'en',
            description: 'Preferred transcript language as a BCP-47 code',
          },
        ],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getFormats(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const base = await baseUrl(this);
        const health = (await this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, healthRequest(base))) as {
          formats?: { id: string; description?: string }[];
        };
        return (health.formats ?? []).map((f) => ({ name: f.id, value: f.id, description: f.description }));
      },
      async getCollections(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const base = await baseUrl(this);
        const listed = (await this.helpers.httpRequestWithAuthentication.call(
          this,
          CREDENTIAL,
          listCollectionsRequest(base),
        )) as { collections?: { id: string; name: string; videoIds?: string[] }[] };
        return (listed.collections ?? []).map((c) => ({
          name: c.name,
          value: c.id,
          description: `${c.videoIds?.length ?? 0} videos`,
        }));
      },
    },
  };

  async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
    const items = this.getInputData();
    const out: INodeExecutionData[] = [];
    const base = await baseUrl(this);
    const send = (options: IHttpRequestOptions) => this.helpers.httpRequestWithAuthentication.call(this, CREDENTIAL, options);

    for (let i = 0; i < items.length; i++) {
      try {
        const operation = this.getNodeParameter('operation', i) as string;
        if (operation === 'addToCollection') {
          const request = addToCollectionRequest(base, {
            collectionId: this.getNodeParameter('collectionId', i) as string,
            inputs: parseInputs(this.getNodeParameter('inputs', i) as string),
            limit: this.getNodeParameter('maxNew', i, 0) as number,
          });
          // { collection, summary } when the server ingests inline; the ingest Job when it runs a queue.
          out.push({ json: (await send(request)) as IDataObject, pairedItem: { item: i } });
          continue;
        }
        const url = this.getNodeParameter('url', i) as string;
        const options = this.getNodeParameter('options', i, {}) as { mode?: string; lang?: string };
        const video = { url, mode: options.mode, lang: options.lang };
        let json: IDataObject;
        if (operation === 'getTranscript') {
          const params: TranscriptParams = {
            ...video,
            format: this.getNodeParameter('format', i, 'text') as string,
            timestamps: this.getNodeParameter('timestamps', i, false) as boolean,
          };
          json = transcriptItem(params, (await send(transcriptRequest(base, params))) as FullResponse);
        } else if (operation === 'getMetadata') {
          const res = (await send(metadataRequest(base, video))) as FullResponse;
          if (isMissingRoute(res)) {
            // Servers from before GET /metadata existed: read it from the full context.
            json = ((await send(contextRequest(base, video))) as { metadata: IDataObject }).metadata;
          } else if (res.statusCode >= 400) {
            throw new NodeApiError(this.getNode(), (res.body ?? {}) as JsonObject, {
              itemIndex: i,
              httpCode: String(res.statusCode),
              message: apiErrorMessage(res),
              description: apiErrorMessage(res),
            });
          } else {
            json = res.body as IDataObject;
          }
        } else if (operation === 'listItems') {
          const limit = this.getNodeParameter('limit', i, 50) as number;
          const listed = (await send(itemsRequest(base, { url, limit }))) as { items?: IDataObject[] };
          for (const ref of listed.items ?? []) out.push({ json: ref, pairedItem: { item: i } });
          continue;
        } else if (operation === 'getContext') {
          json = (await send(contextRequest(base, video))) as IDataObject;
        } else {
          throw new NodeOperationError(this.getNode(), `Unknown operation "${operation}"`, { itemIndex: i });
        }
        out.push({ json, pairedItem: { item: i } });
      } catch (error) {
        if (this.continueOnFail()) {
          // n8n replaces the message of HTTP errors with a generic one; the API's own text is in the description.
          const description = (error as { description?: string }).description;
          out.push({
            json: { error: (error as Error).message, ...(description ? { description } : {}) },
            pairedItem: { item: i },
          });
          continue;
        }
        if (error instanceof NodeOperationError || error instanceof NodeApiError) throw error;
        throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: i });
      }
    }
    return [out];
  }
}
