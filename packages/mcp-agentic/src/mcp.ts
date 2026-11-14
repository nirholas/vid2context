/**
 * Registration entry, following the `register<Name>Tools(server, deps)`
 * pattern in docs/contracts/mcp-tools.md. packages/mcp calls this from
 * createServer before connecting a transport.
 */
export { registerAgenticFeatures } from './register.ts';
