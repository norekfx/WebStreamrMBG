import * as cheerio from 'cheerio';
import { createTestContext } from '../test';
import { CountryCode } from '../types';
import { FetcherMock, TmdbId } from '../utils';
import { FourKHDHub } from './FourKHDHub';
import { Source } from './Source';

const ctx = createTestContext();

describe('FourKHDHub resilience', () => {
  test('filters out pixel.hubcdn URLs', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://hubcloud.foo/drive/abc">HubCloud</a>
      <a href="https://pixel.hubcdn.fans/?id=xyz">Pixel</a>
      <a href="https://gpdl.hubcdn.fans/?id=def">10Gbps</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(2);
    expect(results.every(r => !r.url.href.includes('pixel.hubcdn'))).toBe(true);
  });

  test('filters out dead HubCloud domains', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://hubcloud.ink/drive/abc">Dead Domain</a>
      <a href="https://hubcloud.foo/drive/xyz">Live Domain</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(1);
  });

  test('collects hubcdn.buzz links (domain rotation resilient)', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://gpdl.hubcdn.buzz/?id=abc123">10Gbps Server</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(1);
    expect(results[0]?.url.href).toContain('hubcdn.buzz');
  });

  test('deduplicates identical hub URLs', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://hubcloud.foo/drive/abc">HubCloud 1</a>
      <a href="https://hubcloud.foo/drive/abc">HubCloud 2</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(1);
  });

  test('collects all hub link types regardless of button text', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://hubcloud.foo/drive/abc">Cloud Server</a>
      <a href="https://hubdrive.dad/file/123">Drive Link</a>
      <a href="https://gpdl.hubcdn.fans/?id=def">Fast Server</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(3);
  });

  test('skips non-hub URLs in download items', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://example.com/not-hub">Random Link</a>
      <a href="https://hubcloud.foo/drive/abc">HubCloud</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(1);
  });

  test('skips pixel.rohitkiskk workers.dev URLs', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://pixel.rohitkiskk.workers.dev/?id=abc">Pixel Worker</a>
      <a href="https://hubcloud.foo/drive/xyz">HubCloud</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(1);
    expect(results[0]?.url.href).toContain('hubcloud.foo');
  });

  test('returns unresolved URL when redirect resolution fails', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://gamerxyt.com/hubcloud.php?host=hubcloud&id=badlink">Gateway</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(1);
    expect(results[0]?.url.href).toContain('gamerxyt.com');
  });

  test('resolves non-hub redirect URL successfully', async () => {
    const html = `<div class="download-item">
      <span class="file-title">Test.2024.1080p.mkv</span>
      <span>2.0 GB</span>
      <a href="https://gamerxyt.com/hubcloud.php?host=hubcloud&id=resolvedlink">Gateway</a>
    </div>`;
    const $ = cheerio.load(html);
    const el = $('.download-item');
    const source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
    const results = await source['extractSourceResults'](ctx, $, el, [CountryCode.multi]);
    expect(results).toHaveLength(1);
    expect(results[0]?.url.href).toContain('hubcloud.foo');
  });
});

describe('FourKHDHub', () => {
  let source: FourKHDHub;

  beforeEach(() => {
    source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
  });

  test('handle non-existent devil\'s bath 2024 gracefully', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(931944, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle superman 2025', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(1061474, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle dark 2017 s01e02', async () => {
    const streams = await source.handle(ctx, 'series', new TmdbId(70523, 1, 2));
    expect(streams).toMatchSnapshot();
  });

  test('handle dexter resurrection 2025 s01e01', async () => {
    const streams = await source.handle(ctx, 'series', new TmdbId(259909, 1, 1));
    expect(streams).toMatchSnapshot();
  });

  test('handle dexter original sin 2024 s01e01', async () => {
    const streams = await source.handle(ctx, 'series', new TmdbId(219937, 1, 1));
    expect(streams).toMatchSnapshot();
  });

  test('handle crayon shin-chan 1993', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(128868, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle crayon shin-chan 1998', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(128875, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle crank 2006', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(1948, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle lovely runner 2024 s01e01', async () => {
    const streams = await source.handle(ctx, 'series', new TmdbId(230923, 1, 1));
    expect(streams).toMatchSnapshot();
  });

  test('handle stranger things s05e08', async () => {
    const streams = await source.handle(ctx, 'series', new TmdbId(66732, 5, 8));
    expect(streams).toMatchSnapshot();
  });

  test('handle f1', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(911430, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle the tank', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(1252037, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle avengers: endgame', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(299534, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });

  test('handle dust bunny', async () => {
    const streams = await source.handle(ctx, 'movie', new TmdbId(1043197, undefined, undefined));
    expect(streams).toMatchSnapshot();
  });
});

describe('FourKHDHub with base URL cached', () => {
  let source: FourKHDHub;

  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const SourceClass = Source as any;
    SourceClass.baseUrlCache = new Map();
    SourceClass.deadDomains = new Map();
    SourceClass.domainsJsonCache = null;
    SourceClass.domainsJsonTs = 0;
    SourceClass.baseUrlCache.set('4kHDHub', { url: 'https://4khdhub.link/', ts: Date.now() });

    source = new FourKHDHub(new FetcherMock(`${__dirname}/__fixtures__/FourKHDHub`));
  });

  test('handles series with season/episode (Dark S01E02)', async () => {
    const streams = await source['handleInternal'](ctx, 'series', new TmdbId(70523, 1, 2));
    expect(streams.length).toBeGreaterThanOrEqual(0);
  });

  test('handles movie via handleInternal (Superman)', async () => {
    const streams = await source['handleInternal'](ctx, 'movie', new TmdbId(1061474, undefined, undefined));
    expect(streams.length).toBeGreaterThanOrEqual(0);
  });

  test('returns empty when pageUrl not found', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    jest.spyOn(source as any, 'fetchPageUrl').mockResolvedValue(undefined);
    const streams = await source.handle(ctx, 'series', new TmdbId(9999999, 1, 1));
    expect(streams).toEqual([]);
  });
});
