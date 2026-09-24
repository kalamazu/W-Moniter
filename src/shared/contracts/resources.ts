export interface ResourceEvidence { seq: number; observedAt: number; status: number | null }
export interface ResourceVersion {
  id: string; url: string; origin: string; path: string; version: number
  resourceType?: string; mimeType?: string; bodyHash?: string; size: number
  firstSeenAt: number; lastSeenAt: number; evidence: ResourceEvidence[]
}
export interface ResourceIndexCoverage { scanned: number; versions: number; indexed: number; binary: number; missingBody: number; truncated: number; canceled: boolean; builtAt: number }
export interface ResourceSearchHit { resource: ResourceVersion; score: number; snippet: string; matchedIn: 'url' | 'text'; evidenceSeq: number }
export interface ResourceNote { id: string; resourceId?: string; origin?: string; version: number; text: string; createdAt: number; updatedAt: number }
export interface EndpointOverride { id: string; kind: 'merge' | 'split'; keys: string[]; label?: string; version: number; createdAt: number }
export interface SiteDossier { origin: string; visits: number; resources: number; versions: number; bytes: number; firstSeenAt: number; lastSeenAt: number; types: Record<string, number> }

