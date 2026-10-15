/** Same-origin private business API; browser storage never holds profiles, material or passwords. */
import type { Member, Profile, Work, WorkId, WorkspaceView } from '@deepseek-ai/dsh-experimental-education-workbench/types'

/** An actionable server response; 401 returns the UI to login. */
export class ApiError extends Error {
  /** @param status - response status. @param message - public response text. */
  constructor(readonly status: number, message: string) { super(message) }
}

/** @param path - business route. @param input - optional POST payload. @returns a typed response from the validated server. */
export async function request<T>(path: string, input?: object): Promise<T> {
  let response: Response
  try {
    response = await fetch(`/business-api${path}`, input === undefined ? { credentials: 'same-origin', cache: 'no-store' } : { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Workbench-Request': '1' }, body: JSON.stringify(input) })
  } catch { throw new ApiError(0, '无法连接服务器。请重新加载确认保存状态后再重试。') }
  const value: unknown = await response.json()
  if (!response.ok) {
    const message = typeof value === 'object' && value !== null && 'error' in value && typeof value.error === 'string' ? value.error : `请求未完成 (${response.status})。`
    throw new ApiError(response.status, message)
  }
  return value as T
}

/** React-free commands keep all authority on the server. */
export const client = {
  load: (): Promise<WorkspaceView> => request('/workspace'),
  setup: (): Promise<{ registrationOpen: boolean }> => request('/setup'),
  login: (input: object, register: boolean): Promise<{ member: Member }> => request(register ? '/register' : '/login', input),
  logout: (): Promise<{ ok: true }> => request('/logout', {}),
  profile: (input: Profile): Promise<WorkspaceView> => request('/profile', input),
  material: (input: object): Promise<WorkspaceView> => request('/materials', input),
  authorization: (id: string, revision: number, authorized: boolean): Promise<WorkspaceView> => request(`/materials/${id}`, { revision, authorized }),
  create: (input: object): Promise<{ work: Work; workspace: WorkspaceView }> => request('/works', input),
  save: (id: WorkId, revision: number, title: string, content: string): Promise<{ work: Work; workspace: WorkspaceView }> => request(`/works/${id}`, { revision, title, content }),
  generate: (id: WorkId, revision: number, instruction: string, requestId: string): Promise<{ work: Work; workspace: WorkspaceView }> => request(`/works/${id}/turn`, { revision, instruction, requestId }),
  cancel: (id: WorkId): Promise<{ ok: true }> => request(`/works/${id}/cancel`, {}),
  metrics: (input: object): Promise<WorkspaceView> => request('/metrics', input),
}
