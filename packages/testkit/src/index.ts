/**
 * @vid2context/testkit: conformance suites for providers, storage backends
 * and formatters, registry invariants, and a fixture recorder. Node-only (it
 * reads fixtures and writes recordings); providers import it only in tests.
 */
export { type CaptionCase, type CaptionCases, describeCaptions, transcriptProblems } from './captions.ts';
export {
  BCP47,
  contextFixturesDir,
  loadContextFixture,
  loadContextFixtures,
  NetworkTouched,
  offlineContext,
  repoRoot,
  withoutNetwork,
  withoutNetworkAsync,
} from './fixtures.ts';
export { describeFormatter, FORMAT_OPTION_SETS } from './formatter.ts';
export {
  type CheckOptions,
  checkInvariants,
  formatReport,
  type InvariantReport,
  RUNTIMES,
  scanPortable,
  stripComments,
  type Violation,
} from './invariants.ts';
export {
  fixtureRoutes,
  type RecordedExchange,
  type RecordingFetch,
  type RecordingOptions,
  readRecorded,
  recordingFetch,
} from './recorder.ts';
export { expectedCodeForStatus, expectedRungId, type RungKind, rungProblems } from './rung-checks.ts';
export {
  describeEmbedRung,
  describeLlmRung,
  describeSttRung,
  type EmbedRecorded,
  type LlmRecorded,
  type RecordedErrorCase,
  type SttRecorded,
} from './rungs.ts';
export { REDACTED, REDACTED_URL, Scrubber, type ScrubOptions, type ScrubReport } from './scrub.ts';
export { describeSource, type MatchCase, type MetadataCase, metadataProblems, refProblems, type SourceCases } from './source.ts';
export { describeStorage, letterVector, type StorageFactory, type StorageSuiteOptions } from './storage.ts';
