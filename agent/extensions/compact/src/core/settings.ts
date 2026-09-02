export interface CompactorSettings {
  /** Handle all compaction paths: /compact, auto threshold/overflow. */
  overrideDefaultCompaction: boolean;
  /** Boost default keep:1 tail when small (<= 5k tokens), up to 25k token tail. Explicit keep:N respected. */
  smartKeepTail: boolean;
  /** Ask agent to continue after successful automatic compaction. */
  continueAfterThresholdCompact: boolean;
  /** Write debug snapshot to /tmp/compact-debug.json on each compaction. */
  debug: boolean;
}

export const DEFAULT_SETTINGS: CompactorSettings = {
  overrideDefaultCompaction: true,
  smartKeepTail: true,
  continueAfterThresholdCompact: true,
  debug: false,
};

export const loadSettings = (): CompactorSettings => DEFAULT_SETTINGS;
