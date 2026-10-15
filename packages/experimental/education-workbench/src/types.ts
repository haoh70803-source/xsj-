/** Private education-content records exposed by the workbench API. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Account identity in the standalone prototype. */
export type MemberId = Branded<'EducationMemberId'>
/** Owner-private prototype material identity. */
export type MaterialId = Branded<'EducationMaterialId'>
/** Owner-private prototype work identity. */
export type WorkId = Branded<'EducationWorkId'>

/** Public fields of the authenticated prototype account. */
export interface Member {
  id: MemberId
  username: string
}

/** Confirmed owner profile supplied to prototype content requests. */
export interface Profile {
  displayName: string
  role: string
  institution: string
  audience: string
  voice: string
  facts: string
  forbiddenClaims: string
}

/** Private material text and its current authorization state. */
export interface Material {
  id: MaterialId
  title: string
  content: string
  sourceUrl: string
  authorized: boolean
  revision: number
  updatedAt: string
}

/** Content workflows supported by the standalone prototype. */
export type WorkKind = 'script' | 'moments' | 'analysis'

/** One persistent owner conversation entry and its original request identity. */
export interface Dialogue {
  role: 'user' | 'assistant'
  text: string
  createdAt: string
  requestId: string
}

/** Mutable prototype draft and its retained conversation. */
export interface Work {
  id: WorkId
  title: string
  kind: WorkKind
  topic: string
  sourceIds: MaterialId[]
  content: string
  dialogue: Dialogue[]
  revision: number
  updatedAt: string
  lastError: string | null
  pendingRequest: string | null
}

/** Explicitly imported platform observation; no live platform query is implied. */
export interface ContentMetric {
  platform: 'douyin' | 'xiaohongshu'
  account: string
  title: string
  likes: number
  keywords: string[]
  url: string
}

/** Imported observations with source and observation timestamps. */
export interface MetricDataset {
  rows: ContentMetric[]
  sourceLabel: string
  observedAt: string
  importedAt: string
}

/** Summary derived only from the imported dataset for one account. */
export interface AccountAnalysis {
  platform: ContentMetric['platform']
  account: string
  count: number
  medianLikes: number
  aboveMedian: ContentMetric[]
}

/** Durable owner-private prototype document. */
export interface WorkspaceState {
  version: 1
  profile: Profile | null
  materials: Material[]
  works: Work[]
  metrics: MetricDataset | null
}

/** Authorized view combining stored content and current process activity. */
export interface WorkspaceView extends WorkspaceState {
  member: Member
  runningWorkIds: WorkId[]
  accounts: AccountAnalysis[]
}
