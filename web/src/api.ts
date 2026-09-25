import type {
  GenerateRequest,
  GenerateResponse,
  GeocodeResult,
  ImportRequest,
  ImportResponse,
} from '../../shared/types';

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 非 JSON */
  }
  if (!res.ok) {
    throw new Error(json?.error ?? `伺服器錯誤（HTTP ${res.status}）${res.status === 502 || res.status === 504 ? '，請確認 API server 與 BRouter 已啟動' : ''}`);
  }
  return json as T;
}

export async function generateRoutes(req: GenerateRequest): Promise<GenerateResponse> {
  const res = await fetch('/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return handle<GenerateResponse>(res);
}

export async function importTrack(req: ImportRequest): Promise<ImportResponse> {
  const res = await fetch('/api/import', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  return handle<ImportResponse>(res);
}

export async function geocode(q: string): Promise<GeocodeResult[]> {
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`);
  return (await handle<{ results: GeocodeResult[] }>(res)).results;
}
