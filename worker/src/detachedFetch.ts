export function detachedFetch(
  fetcher: typeof fetch,
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  return Reflect.apply(fetcher, undefined, [input, init]) as Promise<Response>;
}
