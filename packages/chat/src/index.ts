/**
 * Building blocks of the chat workspace, for mounting inside the web app
 * (packages/web) by the integration pass. Import the CSS once:
 * `import '@vid2context/chat/src/styles/app.css'` (it includes the tokens).
 */
export { AttachDialog, type AttachDialogProps } from './components/AttachDialog.tsx';
export { ChatApp, type ChatAppProps } from './components/ChatApp.tsx';
export { ChatWorkspace, type ChatWorkspaceProps, PROVIDERS_DOC_URL } from './components/ChatWorkspace.tsx';
export { CitationChip, CitationContext, CitationGroup, TextWithCitations } from './components/CitationChip.tsx';
export { Composer, type ComposerProps, ContextChip } from './components/Composer.tsx';
export { ErrorCard } from './components/ErrorCard.tsx';
export { AUTO_DESCRIPTION, ModelPicker, type ModelPickerProps } from './components/ModelPicker.tsx';
export { SettingsDialog, type SettingsDialogProps, SHORTCUTS } from './components/SettingsDialog.tsx';
export { Sidebar, type SidebarProps } from './components/Sidebar.tsx';
export { default as SourcePanel, embedUrl, type SourcePanelProps, youtubeIdOf } from './components/SourcePanel.tsx';
export { Thread, type ThreadProps } from './components/Thread.tsx';
export { TokenMeter } from './components/TokenMeter.tsx';
export { ApiClient, type ApiClientOptions, ApiError, chatEventsFromSse, errorFromApi, toErrorData } from './lib/api.ts';
export { type Backend, type BackendFeatures, ClientBackend, requestContext, ServerBackend } from './lib/backend.ts';
export { createBackend, createClientBackend } from './lib/bootstrap.ts';
export * from './lib/citations.ts';
export { browserCorsFor, MEASURED_CORS } from './lib/cors.ts';
export { contextFromPaste, parseContextJson, parseTranscriptText } from './lib/local-context.ts';
export { localChat } from './lib/local-engine.ts';
export * from './lib/meter.ts';
export * from './lib/models.ts';
export { buildGrounding, excerptsOf } from './lib/sources.ts';
export { parseSse, type SseMessage } from './lib/sse.ts';
export { type ChatStore, IdbChatStore, MemoryChatStore, openChatStore } from './lib/store.ts';
export type * from './lib/types.ts';
