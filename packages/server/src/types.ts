import type { Principal } from './auth.ts';
import type { RouteDocs } from './openapi.ts';
import type { Services } from './services.ts';

export interface Vars {
  requestId: string;
  /** The API key that authenticated this request; absent in open mode. */
  principal?: Principal;
}

export type AppEnv = { Variables: Vars };

export interface RouteDeps {
  services: Services;
  docs: RouteDocs;
  version: string;
}
