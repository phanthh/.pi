import type { CompactionReason } from "./types";

export interface CompactionDetails {
  compactor: "algorithmic";
  version: number;
  sections: string[];
  sourceMessageCount: number;
  previousSummaryUsed: boolean;
  reason?: CompactionReason;
  willRetry?: boolean;
}
