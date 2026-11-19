export type Role = 'salesman' | 'manager' | 'admin'

export interface Me {
  id: number
  username: string
  role: Role
  /** Full name when the account has one, otherwise the username. */
  name: string
  /** The role as people say it: "Salesman", "Manager", "Admin". */
  designation: string
}

const KEY = 'sm_tokens'
// Empty locally uses Vite's /api proxy; production calls the Cloud Run backend directly.
const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '')
const apiUrl = (path: string) => `${API_BASE}${path}`

export function logout() {
  localStorage.removeItem(KEY)
  window.dispatchEvent(new Event('sm:logout')) // lets the field tracker stop recording (it cannot import this module back)
}

export function isLoggedIn() {
  return !!localStorage.getItem(KEY)
}

export async function login(username: string, password: string): Promise<void> {
  const res = await fetch(apiUrl('/api/auth/token/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.status === 429) throw new Error('Too many sign-in attempts. Wait a minute, then try again.')
  if (!res.ok) throw new Error('Invalid username or password')
  localStorage.setItem(KEY, JSON.stringify(await res.json()))
}

/**
 * Changes the signed-in user's own password. A password change signs an account out everywhere (tokens carry a hash of the
 * password), so the server answers with a fresh token pair for this session, and it replaces the old one here.
 */
export async function changePassword(current: string, next: string): Promise<void> {
  const tokens = await api<{ access: string; refresh: string }>('/api/me/password/', { method: 'POST', body: { current_password: current, new_password: next } })
  localStorage.setItem(KEY, JSON.stringify(tokens))
}

async function refresh(): Promise<boolean> {
  const tokens = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  if (!tokens?.refresh) return false
  const res = await fetch(apiUrl('/api/auth/token/refresh/'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh: tokens.refresh }),
  })
  if (!res.ok) return false
  localStorage.setItem(KEY, JSON.stringify({ ...tokens, ...(await res.json()) }))
  return true
}

export class ApiError extends Error {
  status: number
  data: unknown
  constructor(status: number, data: unknown) {
    super(`Request failed (${status})`)
    this.status = status
    this.data = data
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, retry = true): Promise<T> {
  const tokens = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  const headers: Record<string, string> = {}
  if (tokens?.access) headers.Authorization = `Bearer ${tokens.access}`
  const isForm = init.body instanceof FormData
  if (init.body !== undefined && !isForm) headers['Content-Type'] = 'application/json'
  const res = await fetch(apiUrl(path), {
    method: init.method ?? 'GET',
    headers,
    body: init.body === undefined ? undefined : isForm ? (init.body as FormData) : JSON.stringify(init.body),
  })
  if (res.status === 401 && retry && (await refresh())) return api<T>(path, init, false)
  if (res.status === 401) logout()
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  return res.status === 204 ? (undefined as T) : res.json()
}

/** A file download (Excel / PDF report) with the same sign-in and token refresh as `api`. */
export async function apiFile(path: string, retry = true): Promise<{ blob: Blob; filename: string }> {
  const tokens = JSON.parse(localStorage.getItem(KEY) ?? 'null')
  const res = await fetch(apiUrl(path), { headers: tokens?.access ? { Authorization: `Bearer ${tokens.access}` } : {} })
  if (res.status === 401 && retry && (await refresh())) return apiFile(path, false)
  if (res.status === 401) logout()
  if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null))
  const named = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') ?? '')
  return { blob: await res.blob(), filename: named?.[1] ?? 'report' }
}

export const fetchMe = () => api<Me>('/api/me/')

export const homeFor = (role: Role) => (role === 'salesman' ? '/record-visit' : '/dashboard')
