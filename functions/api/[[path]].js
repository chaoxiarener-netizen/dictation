/**
 * Cloudflare Pages Function：把 /api/* 转发到已有的同步 Worker。
 * 这样站点和接口同一个域名，国内手机不用跨域、也不用记两个地址。
 * 只在 pages.dev 上生效；GitHub Pages 那边仍直连 Worker。
 */
const UPSTREAM = 'https://dictation-sync.chaoxiarener.workers.dev';

export async function onRequest(context) {
  const { request } = context;
  const src = new URL(request.url);
  const target = UPSTREAM + src.pathname + src.search;

  const headers = new Headers();
  const auth = request.headers.get('authorization');
  if (auth) headers.set('authorization', auth);
  const ct = request.headers.get('content-type');
  if (ct) headers.set('content-type', ct);

  let body;
  if (request.method === 'POST' || request.method === 'PUT') {
    body = await request.arrayBuffer();
  }

  const upstream = await fetch(target, {
    method: request.method,
    headers,
    body,
    redirect: 'follow',
  });

  const outHeaders = new Headers(upstream.headers);
  outHeaders.set('access-control-allow-origin', '*');
  outHeaders.set('cache-control', 'no-store');

  return new Response(upstream.body, { status: upstream.status, headers: outHeaders });
}
