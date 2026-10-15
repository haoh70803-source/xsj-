/** Compile-only consumer of the built public Remote/type exports; run after the package build. */
import type {} from '@deepseek-ai/dsh-experimental-education-controller/remote'
import type {
  EducationRemoteErrorCode,
  ProjectFollowFrame,
} from '@deepseek-ai/dsh-experimental-education-controller/types'
import type {
  TypertClientRemote,
  RemoteResult,
  RemoteErrorDetailsMap,
  RemoteStreamHandle,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  ProjectCreated,
  CreateProjectInput,
  ProjectId,
} from '@deepseek-ai/dsh-experimental-education-platform/types'

declare const remote: TypertClientRemote
declare const input: CreateProjectInput
declare const projectId: ProjectId
const created: Promise<RemoteResult<ProjectCreated>> = remote.education.projectsCreate(input)
const followed: RemoteStreamHandle<ProjectFollowFrame, never> = remote.education.projectsFollow({ projectId })
const code: EducationRemoteErrorCode = 'education/DRAFT_CONFLICT'
const details: RemoteErrorDetailsMap['education/DRAFT_CONFLICT'] = {}
void [created, followed, code, details]
