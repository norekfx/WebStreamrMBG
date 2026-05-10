import { createTestContext } from '../test';
import { FetcherMock } from './FetcherMock';
import {
  buildMediaFlowProxyExtractorRedirectUrl,
  buildMediaFlowProxyExtractorStreamUrl,
  buildMediaFlowProxyHlsUrl,
  supportsMediaFlowProxy,
} from './media-flow-proxy';

const ctxWithProxy = createTestContext({ mediaFlowProxyUrl: 'proxy.example.com', mediaFlowProxyPassword: 'secret' });
const ctxWithProxyNoPassword = createTestContext({ mediaFlowProxyUrl: 'proxy.example.com' });
const ctxWithoutProxy = createTestContext();
const fetcher = new FetcherMock(`${__dirname}/__fixtures__/media-flow-proxy`);

describe('supportsMediaFlowProxy', () => {
  test('returns true when mediaFlowProxyUrl is set', () => {
    expect(supportsMediaFlowProxy(ctxWithProxy)).toBe(true);
  });

  test('returns false when mediaFlowProxyUrl is not set', () => {
    expect(supportsMediaFlowProxy(ctxWithoutProxy)).toBe(false);
  });
});

describe('buildMediaFlowProxyHlsUrl', () => {
  test('builds url without headers', () => {
    const url = buildMediaFlowProxyHlsUrl(ctxWithProxy, new URL('https://example.com/stream.m3u8'));
    expect(url.pathname).toBe('/proxy/hls/manifest.m3u8');
    expect(url.searchParams.get('d')).toBe('https://example.com/stream.m3u8');
    expect(url.searchParams.get('api_password')).toBe('secret');
    expect(url.searchParams.has('force_playlist_proxy')).toBe(false);
  });

  test('builds url with headers and proxySegments', () => {
    const url = buildMediaFlowProxyHlsUrl(ctxWithProxy, new URL('https://example.com/stream.m3u8'), { Referer: 'https://ref.com' }, true);
    expect(url.searchParams.get('force_playlist_proxy')).toBe('true');
    expect(url.searchParams.get('h_referer')).toBe('https://ref.com');
  });
});

describe('buildMediaFlowProxyExtractorRedirectUrl', () => {
  test('builds redirect url', () => {
    const url = buildMediaFlowProxyExtractorRedirectUrl(ctxWithProxy, 'example.com', new URL('https://example.com/video'), { Referer: 'https://ref.com' });
    expect(url.pathname).toBe('/extractor/video');
    expect(url.searchParams.get('redirect_stream')).toBe('true');
    expect(url.searchParams.get('host')).toBe('example.com');
    expect(url.searchParams.get('h_referer')).toBe('https://ref.com');
  });
});

describe('buildMediaFlowProxyExtractorStreamUrl', () => {
  test('builds stream url from extractor result', async () => {
    const url = await buildMediaFlowProxyExtractorStreamUrl(ctxWithProxy, fetcher, 'example.com', new URL('https://example.com/video'), { Referer: 'https://ref.com' });
    expect(url).toBeInstanceOf(URL);
    expect(url.searchParams.has('d')).toBe(true);
  });
});

describe('buildMediaFlowProxyExtractorRedirectUrl without headers', () => {
  test('builds redirect url with default empty headers', () => {
    const url = buildMediaFlowProxyExtractorRedirectUrl(ctxWithProxy, 'example.com', new URL('https://example.com/video'));
    expect(url.pathname).toBe('/extractor/video');
    expect(url.searchParams.get('redirect_stream')).toBe('true');
  });
});

describe('api_password handling', () => {
  test('buildMediaFlowProxyExtractorRedirectUrl omits api_password when not set', () => {
    const url = buildMediaFlowProxyExtractorRedirectUrl(ctxWithProxyNoPassword, 'example.com', new URL('https://example.com/video'));
    expect(url.searchParams.has('api_password')).toBe(false);
  });

  test('buildMediaFlowProxyHlsUrl omits api_password when not set', () => {
    const url = buildMediaFlowProxyHlsUrl(ctxWithProxyNoPassword, new URL('https://example.com/stream.m3u8'));
    expect(url.searchParams.has('api_password')).toBe(false);
  });
});
