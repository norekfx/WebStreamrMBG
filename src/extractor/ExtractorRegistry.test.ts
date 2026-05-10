import winston from 'winston';
import { createTestContext } from '../test';
import { Context, Format, InternalUrlResult, Meta, UrlResult } from '../types';
import { FetcherMock } from '../utils';
import { Extractor } from './Extractor';
import { ExtractorRegistry } from './ExtractorRegistry';
import { createExtractors } from './index';

const logger = winston.createLogger({ transports: [new winston.transports.Console({ level: 'nope' })] });
const extractorRegistry = new ExtractorRegistry(logger, createExtractors(new FetcherMock(`${__dirname}/__fixtures__/ExtractorRegistry`), logger));

/** Mock extractor: two hosts resolve to same canonical URL */
class MockHubExtractor extends Extractor {
  public readonly id = 'mockhub';
  public readonly label = 'MockHub';
  public extractCount = 0;

  public supports(_ctx: Context, url: URL): boolean {
    return url.host === 'mockdrive.test' || url.host === 'mockcloud.test';
  }

  public override async normalizeAsync(): Promise<URL> {
    return new URL('https://mockcloud.test/same-file');
  }

  protected async extractInternal(_ctx: Context, _url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    this.extractCount++;
    return [{ url: new URL('https://mockcloud.test/same-file'), format: Format.unknown, meta }];
  }
}

/** Mock lazy-extract extractor */
class MockLazyExtractor extends Extractor {
  public readonly id: string = 'mocklazy';
  public readonly label: string = 'MockLazy';
  public override readonly lazyExtract = true;
  public extractCount = 0;

  public supports(_ctx: Context, url: URL): boolean {
    return url.host === 'lazy.test';
  }

  protected async extractInternal(_ctx: Context, _url: URL, meta: Meta): Promise<InternalUrlResult[]> {
    this.extractCount++;
    return [{ url: new URL('https://cdn.test/video.mp4?token=abc'), format: Format.unknown, meta }];
  }
}

/** Mock lazy extractor with MFP proxy — lazy guard should skip /extract/ URLs */
class MockLazyMfpExtractor extends MockLazyExtractor {
  public override readonly id: string = 'mocklazymfp';
  public override readonly label: string = 'MockLazyMFP';
  public override readonly viaMediaFlowProxy = true;

  public override supports(_ctx: Context, url: URL): boolean {
    return url.host === 'lazymfp.test';
  }
}

describe('ExtractorRegistry', () => {
  const ctx = createTestContext();

  test('returns error result from extractor', async () => {
    const urlResult = await extractorRegistry.handle(ctx, new URL('https://some-url.test'));

    expect(urlResult).toMatchSnapshot();
  });

  test('returns external URLs if enabled by config', async () => {
    const urlResult = await extractorRegistry.handle({ ...ctx, config: { ...ctx.config, includeExternalUrls: 'on' } }, new URL('https://mixdrop.ag/e/3nzwveprim63or6'));

    expect(urlResult).toMatchSnapshot();
  });

  test('does not return external URLs by default', async () => {
    const urlResult = await extractorRegistry.handle(ctx, new URL('https://mixdrop.ag/e/l7v73zqrfdj19z'));

    expect(urlResult).toStrictEqual([]);
  });

  test('returns from memory cache if possible', async () => {
    const urlResults1 = await extractorRegistry.handle(ctx, new URL('https://dropload.io/lyo2h1snpe5c.html'));
    const urlResults2 = await extractorRegistry.handle(ctx, new URL('https://dropload.io/lyo2h1snpe5c.html'));

    expect(urlResults1).not.toStrictEqual([]);
    expect(urlResults2).not.toStrictEqual([]);
  });

  test('ignores not found errors but caches them', async () => {
    const urlResults1 = await extractorRegistry.handle(ctx, new URL('https://dropload.io/asdfghijklmn.html'));
    const urlResults2 = await extractorRegistry.handle(ctx, new URL('https://dropload.io/asdfghijklmn.html'));

    expect(urlResults1).toStrictEqual([]);
    expect(urlResults2).toStrictEqual([]);
  });

  test('returns external url for error', async () => {
    const urlResults = await extractorRegistry.handle(ctx, new URL('https://dropload.io/mocked-blocked.html'));
    expect(urlResults).toMatchSnapshot();
  });

  test('empty results are cached', async () => {
    const urlResults = await extractorRegistry.handle(ctx, new URL('https://dropload.io/asdfghijklmn.html'), { title: 'title' });
    expect(urlResults).toMatchSnapshot();
  });

  test('stats returns something', async () => {
    const stats = extractorRegistry.stats();

    expect(stats).toHaveProperty('urlResultCache');
    expect(stats.urlResultCache).toBeTruthy();
  });

  test('deduplicates concurrent extractions for the same canonical URL', async () => {
    // Slow extractor to guarantee both handle() calls overlap
    class SlowMockExtractor extends MockHubExtractor {
      protected override async extractInternal(ctx: Context, url: URL, meta: Meta): Promise<InternalUrlResult[]> {
        await new Promise(r => setTimeout(r, 100));
        return super.extractInternal(ctx, url, meta);
      }
    }

    const mockExtractor = new SlowMockExtractor(new FetcherMock(`${__dirname}`), logger);
    const registry = new ExtractorRegistry(logger, [mockExtractor]);

    const [driveResults, cloudResults] = await Promise.all([
      registry.handle(ctx, new URL('https://mockdrive.test/file/123')),
      registry.handle(ctx, new URL('https://mockcloud.test/file/abc')),
    ]);

    // extractInternal called only once — in-flight dedup prevented duplicate extraction
    expect(mockExtractor.extractCount).toBe(1);
    expect(driveResults).toHaveLength(cloudResults.length);
  });

  describe('lazyExtract', () => {
    test('returns /extract/ URLs on first call with allowLazy=true', async () => {
      const mockExtractor = new MockLazyExtractor(new FetcherMock(`${__dirname}`), logger);
      const registry = new ExtractorRegistry(logger, [mockExtractor]);

      const urlResults = await registry.handle(ctx, new URL('https://lazy.test/file/1'), { title: 'test' }, true);

      expect(mockExtractor.extractCount).toBe(1);
      expect(urlResults).toHaveLength(1);
      const result = urlResults[0];
      expect(result).toBeDefined();
      expect(result?.url.pathname).toContain('/extract');
      expect(result?.url.searchParams.get('index')).toBe('0');
      expect(result?.url.searchParams.get('url')).toBe('https://lazy.test/file/1');
    });

    test('returns /extract/ URLs from lazy cache on second call without re-extracting', async () => {
      const mockExtractor = new MockLazyExtractor(new FetcherMock(`${__dirname}`), logger);
      const registry = new ExtractorRegistry(logger, [mockExtractor]);

      // First call — populates lazy cache
      await registry.handle(ctx, new URL('https://lazy.test/file/2'), { title: 'test' }, true);
      expect(mockExtractor.extractCount).toBe(1);

      // Second call — should use lazy cache, no re-extraction
      const urlResults = await registry.handle(ctx, new URL('https://lazy.test/file/2'), { title: 'test' }, true);
      expect(mockExtractor.extractCount).toBe(1); // still 1 — no re-extraction
      expect(urlResults).toHaveLength(1);
      expect(urlResults[0]?.url.pathname).toContain('/extract');
    });

    test('returns direct URLs when allowLazy is false (extract endpoint)', async () => {
      const mockExtractor = new MockLazyExtractor(new FetcherMock(`${__dirname}`), logger);
      const registry = new ExtractorRegistry(logger, [mockExtractor]);

      // First call with allowLazy=true to populate caches
      await registry.handle(ctx, new URL('https://lazy.test/file/3'), { title: 'test' }, true);

      // Extract endpoint calls with allowLazy=false
      const urlResults = await registry.handle(ctx, new URL('https://lazy.test/file/3'), { title: 'test' }, false);
      expect(urlResults).toHaveLength(1);
      expect(urlResults[0]?.url.hostname).toBe('cdn.test');
    });

    test('returns /extract/ URLs from lazy cache for non-lazy extractor when urlResultCache expires', async () => {
      const mockExtractor = new MockHubExtractor(new FetcherMock(`${__dirname}`), logger);
      const registry = new ExtractorRegistry(logger, [mockExtractor]);

      const url = new URL('https://mockdrive.test/file/lazy');
      const meta = { title: 'test' };

      // First call — populates both urlResultCache and lazyUrlResultCache
      await registry.handle(ctx, url, meta);
      expect(mockExtractor.extractCount).toBe(1);

      // Simulate urlResultCache expiry by deleting it directly
      const cacheKey = `mockhub_https://mockcloud.test/same-file`;
      await registry['urlResultCache'].delete(cacheKey);

      // Second call with allowLazy=true — lazyUrlResultCache still fresh, urlResultCache expired
      const urlResults = await registry.handle(ctx, url, meta, true);
      expect(mockExtractor.extractCount).toBe(1); // no re-extraction
      expect(urlResults).toHaveLength(1);
      expect(urlResults[0]?.url.pathname).toContain('/extract');
    });

    test('viaMediaFlowProxy=true skips /extract/ URLs even with allowLazy=true', async () => {
      const mockExtractor = new MockLazyMfpExtractor(new FetcherMock(`${__dirname}`), logger);
      const registry = new ExtractorRegistry(logger, [mockExtractor]);

      const urlResults = await registry.handle(ctx, new URL('https://lazymfp.test/file/1'), { title: 'test' }, true);

      expect(urlResults).toHaveLength(1);
      expect(urlResults[0]?.url.hostname).toBe('cdn.test');
      expect(urlResults[0]?.url.pathname).not.toContain('/extract');
    });

    test('lazy extractor uses 7-day TTL for lazyUrlResultCache', async () => {
      const mockExtractor = new MockLazyExtractor(new FetcherMock(`${__dirname}`), logger);
      const registry = new ExtractorRegistry(logger, [mockExtractor]);

      await registry.handle(ctx, new URL('https://lazy.test/file/ttl'), { title: 'test' }, true);

      const raw = await registry['lazyUrlResultCache'].getRaw<UrlResult[]>('https://lazy.test/file/ttl');
      expect(raw?.expires).toBeDefined();
      // 7 days = 604800000ms from Date.now() (639837296000)
      expect(raw?.expires).toBe(639837296000 + 604800000);
    });

    test('non-lazy extractor uses 24h TTL for lazyUrlResultCache', async () => {
      const mockExtractor = new MockHubExtractor(new FetcherMock(`${__dirname}`), logger);
      const registry = new ExtractorRegistry(logger, [mockExtractor]);

      await registry.handle(ctx, new URL('https://mockdrive.test/file/ttl'), { title: 'test' });

      const raw = await registry['lazyUrlResultCache'].getRaw<UrlResult[]>('https://mockcloud.test/same-file');
      expect(raw?.expires).toBeDefined();
      // 24h = 86400000ms from Date.now() (639837296000)
      expect(raw?.expires).toBe(639837296000 + 86400000);
    });
  });
});
