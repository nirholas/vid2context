import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow';

export class Vid2ContextApi implements ICredentialType {
  name = 'vid2contextApi';

  displayName = 'vid2context API';

  icon = 'file:vid2context.svg' as const;

  documentationUrl = 'https://github.com/nirholas/vid2context/tree/main/packages/n8n-nodes#credentials';

  properties: INodeProperties[] = [
    {
      displayName: 'Base URL',
      name: 'baseUrl',
      type: 'string',
      default: 'http://127.0.0.1:8787',
      placeholder: 'https://vid2context.example.com',
      description: 'Where the vid2context HTTP API runs (npm run start:server serves http://127.0.0.1:8787)',
      required: true,
    },
    {
      displayName: 'API Key',
      name: 'apiKey',
      type: 'string',
      typeOptions: { password: true },
      default: '',
      description: 'One of the keys in VID2CONTEXT_API_KEYS on the server. Leave empty when the server runs without keys.',
    },
  ];

  authenticate: IAuthenticateGeneric = {
    type: 'generic',
    properties: {
      headers: {
        Authorization: '=Bearer {{$credentials.apiKey}}',
      },
    },
  };

  test: ICredentialTestRequest = {
    request: {
      baseURL: '={{$credentials.baseUrl.replace(/\\/+$/, "").replace(/\\/api\\/v1$/, "")}}',
      url: '/api/v1/health',
    },
  };
}
