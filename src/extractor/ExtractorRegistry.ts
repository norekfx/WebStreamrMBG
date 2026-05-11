import { Cacheable, CacheableMemory, Keyv } from 'cacheable';
import winston from 'winston';
import { Context, Format, Meta, UrlResult } from '../types';
import { createKeyvSqlite, isExtractorDisabled } from '../utils';
import { Extractor } from './Extractor';

export class ExtractorRegistry {
  private readonly logger: winston.Logger;
  private readonly extractors: Extractor[];

  private readonly urlResultCache: Cacheable;
  private readonly lazyUrlResultCache: Cacheable;

  // In-flight dedup: concurrent requests for same canonical URL share one extraction Promise
  private readonly inFlight = new Map<string, Promise<UrlResult[]>>();

  public constructor(logger: winston.Logger, extractors: Extractor[]) {
    this.logger = logger;
    this.extractors = extractors;

    this.urlResultCache = new Cacheable({
      nonBlocking: true,
      primary: new Keyv({ store: new CacheableMemory({ lruSize: 1024 }) }),
      secondary: createKeyvSqlite('extractor-cache'),
      stats: true,
    });

    this.lazyUrlResultCache = new Cacheable({
      nonBlocking: true,
      primary: new Keyv({ store: new CacheableMemory({ lruSize: 1024 }) }),
      secondary: createKeyvSqlite('extractor-lazy-cache'),
      stats: true,
    });
  }

  public stats() {
    return {
      urlResultCache: this.urlResultCache.stats,
      lazyUrlResultCache: this.lazyUrlResultCache.stats,
    };
  };

  public async handle(ctx: Context, url: URL, meta?: Meta, allowLazy?: boolean): Promise<UrlResult[]> {
    const extractor = this.extractors.find(extractor => !isExtractorDisabled(ctx.config, extractor) && extractor.supports(ctx, url));
    if (!extractor) {
      return [];
    }

    const normalizedUrl = extractor.normalize(url);
    const canonicalUrl = await extractor.normalizeAsync(ctx, normalizedUrl);
    const cacheKey = this.determineCacheKey(ctx, extractor, canonicalUrl);

    // Lazy-extract path: always return /extract/ URLs from cached metadata, never direct URLs
    if (extractor.lazyExtract && allowLazy && !extractor.viaMediaFlowProxy) {
      const lazyUrlResults = await this.lazyUrlResultCache.get<UrlResult[]>(canonicalUrl.href) ?? [];
      if (lazyUrlResults.length) {
        return this.buildExtractUrls(ctx, lazyUrlResults, canonicalUrl);
      }
      // Cache miss — fall through to full extraction, then transform to /extract/ URLs
    }

    const storedDataRaw = await this.urlResultCache.getRaw<UrlResult[]>(cacheKey);
    if (storedDataRaw?.expires) {
      const remainingCacheTtl = storedDataRaw.expires - Date.now();
      // Use the minimum of the per-result TTL and the remaining cache TTL.
      return (storedDataRaw.value as UrlResult[]).map(urlResult => ({
        ...urlResult,
        ttl: Math.min(urlResult.ttl, remainingCacheTtl),
        url: new URL(urlResult.url),
      }));
    }

    const lazyUrlResults = await this.lazyUrlResultCache.get<UrlResult[]>(canonicalUrl.href) ?? [];

    if (
      lazyUrlResults.length && allowLazy && !extractor.viaMediaFlowProxy
      && lazyUrlResults.every(urlResult => urlResult.format !== Format.hls) // related to Android issues, e.g. https://github.com/Stremio/stremio-bugs/issues/1574 or https://github.com/Stremio/stremio-bugs/issues/1579
    ) {
      return this.buildExtractUrls(ctx, lazyUrlResults, canonicalUrl);
    }

    // Reuse in-flight extraction if already running for this canonical URL
    const existing = this.inFlight.get(cacheKey);
    if (existing) {
      return existing;
    }

    const extractionPromise = this.executeExtraction(ctx, extractor, normalizedUrl, canonicalUrl, cacheKey, meta, lazyUrlResults, url);
    this.inFlight.set(cacheKey, extractionPromise);

    try {
      const urlResults = await extractionPromise;

      // Lazy-extract: transform direct URLs to /extract/ URLs even on first extraction
      if (extractor.lazyExtract && allowLazy && !extractor.viaMediaFlowProxy) {
        return this.buildExtractUrls(ctx, urlResults, canonicalUrl);
      }

      return urlResults;
    } finally {
      this.inFlight.delete(cacheKey);
    }
  };

  private async executeExtraction(
    ctx: Context, extractor: Extractor, normalizedUrl: URL, canonicalUrl: URL,
    cacheKey: string, meta: Meta | undefined, lazyUrlResults: UrlResult[], originalUrl: URL,
  ): Promise<UrlResult[]> {
    this.logger.info(`Extract ${originalUrl} using ${extractor.id} extractor`, ctx);

    const mergedMeta: Meta = { ...meta, ...lazyUrlResults[0]?.meta };
    const urlResults = await extractor.extract(ctx, normalizedUrl, { extractorId: extractor.id, ...mergedMeta });

    if (!Object.keys(mergedMeta).length) {
      await this.urlResultCache.delete(cacheKey);
      await this.lazyUrlResultCache.delete(canonicalUrl.href);

      return urlResults;
    }

    // Separate successful results from error results — cache only successes
    const successResults = urlResults.filter(r => !r.error);

    if (successResults.length > 0) {
      // The server-side cache TTL must respect the shortest per-result TTL
      const perResultTtl = Math.min(...successResults.map(r => r.ttl));
      const ttl = Math.min(extractor.ttl, perResultTtl);

      await this.urlResultCache.set<UrlResult[]>(cacheKey, successResults, ttl);

      if (extractor.id !== 'external') {
        const lazyTtl = extractor.lazyExtract ? 604800000 : 86400000; // 7 days for lazy extractors, 24h otherwise
        await this.lazyUrlResultCache.set<UrlResult[]>(canonicalUrl.href, successResults, lazyTtl);
      }
    } else {
      // All results are errors — don't cache, clear any stale cache
      await this.urlResultCache.delete(cacheKey);
      await this.lazyUrlResultCache.delete(canonicalUrl.href);
    }

    return urlResults;
  };

  // Build /extract/ URLs using canonical URL so hubcloud+hubdrive produce identical /extract/ links
  private buildExtractUrls(ctx: Context, urlResults: UrlResult[], canonicalUrl: URL): UrlResult[] {
    return urlResults.map((urlResult, index) => {
      const extractUrl = new URL(`/${encodeURIComponent(JSON.stringify(ctx.config))}/extract/`, ctx.hostUrl);
      extractUrl.searchParams.set('index', `${index}`);
      extractUrl.searchParams.set('url', canonicalUrl.href);
      return { ...urlResult, url: extractUrl };
    });
  }

  private determineCacheKey(ctx: Context, extractor: Extractor, url: URL): string {
    let suffix = '';
    if (extractor.viaMediaFlowProxy) {
      suffix += `_${ctx.config.mediaFlowProxyUrl}`;
    }
    if (extractor.cacheVersion) {
      suffix += `_${extractor.cacheVersion}`;
    }

    return `${extractor.id}_${url}${suffix}`;
  }
}
