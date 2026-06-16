import { NextRequest, NextResponse } from 'next/server';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { API_CONFIG, getAvailableApiSites } from '@/lib/config';
import { SearchResult } from '@/lib/types';

export const runtime = 'edge'; // ✅ 改成 edge（关键）

interface CmsVideoItem {
  vod_id: string | number;
  vod_name: string;
  vod_pic: string;
  vod_remarks?: string;
  vod_year?: string;
  vod_play_from?: string;
  vod_play_url?: string;
}

interface CmsVideoResponse {
  list?: CmsVideoItem[];
  total?: number;
  page?: number;
  pagecount?: number;
}

/** 超时 fetch（真正可靠） */
async function fetchWithTimeout(url: string, timeout = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(url, {
      headers: API_CONFIG.search.headers,
      signal: controller.signal,
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const sourceKey = searchParams.get('source');
  const keyword = searchParams.get('keyword');
  const page = searchParams.get('page') || '1';

  if (!sourceKey || !keyword?.trim()) {
    return NextResponse.json({ error: '参数错误' }, { status: 400 });
  }

  try {
    const includeSpecialSources = searchParams.get('special') === '1';
    const apiSites = await getAvailableApiSites(
      authInfo.username,
      includeSpecialSources
    );

    const targetSite = apiSites.find((s) => s.key === sourceKey);

    if (!targetSite) {
      return NextResponse.json({ error: '未找到源' }, { status: 404 });
    }

    // ✅ 拼接搜索 URL
    const searchUrl =
      `${targetSite.api}?ac=videolist&wd=` +
      encodeURIComponent(keyword) +
      `&pg=${page}`;

    // ✅ Cloudflare safe fetch（5秒）
    const searchResponse = await fetchWithTimeout(searchUrl, 5000);

    if (!searchResponse.ok) {
      return NextResponse.json({
        results: [],
        total: 0,
        page: Number(page),
        pageCount: 0,
      });
    }

    let searchData: CmsVideoResponse;

    try {
      searchData = await searchResponse.json();
    } catch {
      return NextResponse.json({
        results: [],
        total: 0,
        page: Number(page),
        pageCount: 0,
      });
    }

    const list = Array.isArray(searchData.list) ? searchData.list : [];

    // ⚠️ 限制数量（防 CPU 爆炸）
    const safeList = list.slice(0, 20);

    const results: SearchResult[] = safeList.map((item) => {
      const episodes: string[] = [];
      const episodes_titles: string[] = [];

      if (item.vod_play_url && item.vod_play_from) {
        item.vod_play_url.split('#').forEach((ep) => {
          const [name, url] = ep.split('$');
          if (name && url) {
            episodes.push(url.trim());
            episodes_titles.push(name.trim());
          }
        });
      }

      return {
        id: String(item.vod_id || ''),
        title: item.vod_name || '',
        poster: item.vod_pic || '',
        year: item.vod_year || 'unknown',
        episodes,
        episodes_titles,
        source: targetSite.key,
        source_name: targetSite.name,
      };
    });

    return NextResponse.json({
      results,
      total: searchData.total || 0,
      page: Number(page),
      pageCount: searchData.pagecount || 0,
    });
  } catch (e) {
    console.error('search error:', e);

    return NextResponse.json({
      results: [],
      total: 0,
      page: Number(page),
      pageCount: 0,
    });
  }
}
