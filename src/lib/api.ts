import type {
  AnalyzeJobStartResponse,
  AnalyzeJobStatusResponse,
  AnalyzeRequest,
  AnalyzeResponse,
  ApiErrorBody,
  AskRequest,
  AskResponse,
  HealthResponse,
} from '../../shared/types'

export class ApiClientError extends Error {
  readonly code: string
  readonly details?: unknown

  constructor(code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiClientError'
    this.code = code
    this.details = details
  }
}

export async function getHealth(): Promise<HealthResponse> {
  return requestJson<HealthResponse>('/api/health')
}

export async function analyzeVideo(body: AnalyzeRequest): Promise<AnalyzeResponse> {
  return requestJson<AnalyzeResponse>('/api/analyze', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function startAnalyzeJob(body: AnalyzeRequest): Promise<AnalyzeJobStartResponse> {
  return requestJson<AnalyzeJobStartResponse>('/api/analyze/jobs', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

export async function getAnalyzeJob(jobId: string): Promise<AnalyzeJobStatusResponse> {
  return requestJson<AnalyzeJobStatusResponse>(`/api/analyze/jobs/${jobId}`)
}

export async function askVideoQuestion(body: AskRequest): Promise<AskResponse> {
  return requestJson<AskResponse>('/api/ask', {
    method: 'POST',
    body: JSON.stringify(body),
  })
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  })

  const text = await response.text()
  let payload: T | ApiErrorBody | null = null
  if (text.length > 0) {
    try {
      payload = JSON.parse(text) as T | ApiErrorBody
    } catch {
      payload = null
    }
  }

  if (!response.ok) {
    const errorBody = payload as ApiErrorBody | null
    throw new ApiClientError(
      errorBody?.error.code ?? 'REQUEST_FAILED',
      errorBody?.error.message ?? 'The request failed.',
      errorBody?.error.details,
    )
  }

  if (payload === null) {
    throw new ApiClientError(
      'INVALID_RESPONSE',
      'The server returned a response that is not valid JSON.',
      { status: response.status },
    )
  }

  return payload as T
}
