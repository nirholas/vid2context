/**
 * Load videos as LangChain.js Documents, one per chapter, each carrying the
 * video id, title, start and end seconds and a timestamp link in metadata.
 * Feed them to any splitter, vector store or retriever.
 *
 *   npm run start:server                     # in another terminal
 *   npx tsx examples/langchain/loader.ts [base-url]
 *
 * Live, no keys needed. Uses @vid2context/langchain against the HTTP API
 * (default http://127.0.0.1:8787); @langchain/core is its peer dependency.
 */
import { VideoContextLoader } from '@vid2context/langchain';

const loader = new VideoContextLoader(
  ['https://www.youtube.com/watch?v=jNQXAC9IVRw', 'https://www.youtube.com/watch?v=cCPsdFdlshc'],
  {
    baseUrl: process.argv[2] ?? process.env.VID2CONTEXT_URL,
    apiKey: process.env.VID2CONTEXT_API_KEY,
    chunking: 'chapters', // or 'segments', or 'window' with windowSec
    continueOnFailure: true,
  },
);

const docs = await loader.load();
process.stdout.write(`${docs.length} documents\n\n`);
for (const doc of docs.slice(0, 4)) {
  process.stdout.write(`${doc.id}\n  ${JSON.stringify(doc.metadata)}\n  "${doc.pageContent.slice(0, 90)}..."\n`);
}
