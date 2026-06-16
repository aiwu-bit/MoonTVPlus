import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getAvailableApiSites } from '@/lib/config';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge';

// ========================
// 超时工具
// ========================
function timeoutPromise<T>(p: Promise<T>, ms: number, msg: string) {
  let timer: any;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });

  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

// ========================
// fetch（Cloudflare安全版）
// ========================
async function safeFetch(url: string) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0',
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

// ========================
// 主接口
// ========================
export async function GET(req: NextRequest) {
  const auth = getAuthInfoFromCookie(req);
  if (!auth?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(req.url);
  const sourceKey = searchParams.get('source');
  const keyword = searchParams.get('keyword');

  if (!sourceKey || !keyword) {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }

  try {
    const sites = await getAvailableApiSites(auth.username, false);

    // ========================
    // 🔥 1. 优先匹配源
    // ========================
    const target = sites.find(s => s.key === sourceKey);
    if (!target) {
      return NextResponse.json({ results: [] });
    }

    // ========================
    // 🔥 2. 搜索 URL
    // ========================
    const url =
      `${target.api}?ac=videolist&wd=` +
      encodeURIComponent(keyword) +
      `&pg=1`;

    // ========================
    // 🔥 3. 超时保护（5秒硬限制）
    // ========================
    const res = await timeoutPromise(
      safeFetch(url),
      5000,
      'search timeout'
    );

    if (!res.ok) {
      return NextResponse.json({ results: [] });
    }

    let data;
    try {
      data = await res.json();
    } catch {
      return NextResponse.json({ results: [] });
    }

    const list = Array.isArray(data.list) ? data.list : [];

    // ========================
    // 🔥 4. 限制 CPU（关键优化）
    // ========================
    const safeList = list.slice(0, 10);

    const results: SearchResult[] = [];

    for (const item of safeList) {
      try {
        results.push({
          id: String(item.vod_id || ''),
          title: item.vod_name || '',
          poster: item.vod_pic || '',
          year: item.vod_year || 'unknown',
          episodes: [],
          episodes_titles: [],
          source: target.key,
          source_name: target.name,
        });
      } catch {
        continue;
      }
    }

    return NextResponse.json({
      results,
      total: data.total || 0,
      page: 1,
      pageCount: data.pagecount || 0,
    });
  } catch (e) {
    console.error('search error:', e);
    return NextResponse.json({ results: [] });
  }
}
