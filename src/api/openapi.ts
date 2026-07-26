/** Generates an OpenAPI 3.1 description of the static API. */

import type { Settings } from '../core/config.js';

/** Builds the OpenAPI document. Every path is a plain file — no server logic. */
export function buildOpenApi(settings: Settings, generatedAt: string): unknown {
  const base = settings.project.base_url ?? 'https://example.github.io/iptv-nexus';

  const listOf = (ref: string): unknown => ({
    type: 'array',
    items: { $ref: `#/components/schemas/${ref}` },
  });

  const jsonResponse = (schema: unknown, description: string): unknown => ({
    description,
    content: { 'application/json': { schema } },
  });

  const collection = (
    name: string,
    ref: string,
    description: string,
  ): [string, unknown] => [
    `/api/v1/${name}.json`,
    {
      get: {
        summary: description,
        operationId: `get${name[0]?.toUpperCase()}${name.slice(1)}`,
        tags: ['collections'],
        responses: { '200': jsonResponse(listOf(ref), description) },
      },
    },
  ];

  return {
    openapi: '3.1.0',
    info: {
      title: `${settings.project.name} API`,
      version: '1.0.0',
      description:
        `${settings.project.description}\n\n` +
        'This is a **static** API: every endpoint is a pre-generated JSON file served ' +
        'over a CDN. There is no rate limit, no API key and no server. Every file also ' +
        'has a `.gz` sibling.\n\n' +
        `Generated at ${generatedAt}.`,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [{ url: base, description: 'Static CDN' }],
    tags: [
      { name: 'meta', description: 'Manifest and health reporting' },
      { name: 'collections', description: 'Full collections' },
      { name: 'shards', description: 'Pre-filtered slices for cheap client fetches' },
      { name: 'detail', description: 'Single-resource documents' },
    ],
    paths: Object.fromEntries([
      [
        '/api/v1/index.json',
        {
          get: {
            summary: 'API manifest: counts, endpoints and generation timestamp',
            operationId: 'getManifest',
            tags: ['meta'],
            responses: {
              '200': jsonResponse({ $ref: '#/components/schemas/Manifest' }, 'API manifest'),
            },
          },
        },
      ],
      collection('channels', 'Channel', 'All channels with streams, health and EPG links'),
      collection('streams', 'Stream', 'All streams, flattened'),
      collection('countries', 'Country', 'Countries with channel counts'),
      collection('languages', 'Language', 'Languages with channel counts'),
      collection('categories', 'Category', 'Categories with channel counts'),
      collection('regions', 'Region', 'Geographic regions'),
      collection('subdivisions', 'Subdivision', 'Country subdivisions'),
      collection('timezones', 'Timezone', 'Timezones'),
      collection('guides', 'Guide', 'EPG guide links'),
      [
        '/api/v1/health.json',
        {
          get: {
            summary: 'Aggregate stream health report',
            operationId: 'getHealth',
            tags: ['meta'],
            responses: {
              '200': jsonResponse({ $ref: '#/components/schemas/HealthReport' }, 'Health report'),
            },
          },
        },
      ],
      [
        '/api/v1/search.json',
        {
          get: {
            summary: 'Compact client-side search index',
            operationId: 'getSearchIndex',
            tags: ['meta'],
            responses: {
              '200': jsonResponse(
                { $ref: '#/components/schemas/SearchIndex' },
                'Search index',
              ),
            },
          },
        },
      ],
      [
        '/api/v1/channels/{channelId}.json',
        {
          get: {
            summary: 'A single channel with all of its streams and guide links',
            operationId: 'getChannel',
            tags: ['detail'],
            parameters: [
              {
                name: 'channelId',
                in: 'path',
                required: true,
                schema: { type: 'string' },
                example: 'BBCNews.uk',
              },
            ],
            responses: {
              '200': jsonResponse({ $ref: '#/components/schemas/Channel' }, 'Channel'),
              '404': { description: 'Unknown channel' },
            },
          },
        },
      ],
      ...(['country', 'category', 'language'] as const).map((dimension) => [
        `/api/v1/by-${dimension}/{key}.json`,
        {
          get: {
            summary: `Channels filtered by ${dimension}`,
            operationId: `getChannelsBy${dimension[0]?.toUpperCase()}${dimension.slice(1)}`,
            tags: ['shards'],
            parameters: [
              { name: 'key', in: 'path', required: true, schema: { type: 'string' } },
            ],
            responses: { '200': jsonResponse(listOf('Channel'), 'Filtered channels') },
          },
        },
      ]),
      [
        '/epg/guide.xml.gz',
        {
          get: {
            summary: 'Merged XMLTV guide for every linked channel (gzipped)',
            operationId: 'getGuide',
            tags: ['meta'],
            responses: {
              '200': { description: 'XMLTV document', content: { 'application/xml': {} } },
            },
          },
        },
      ],
      [
        '/playlists/index.m3u',
        {
          get: {
            summary: 'Master M3U playlist',
            operationId: 'getPlaylist',
            tags: ['meta'],
            responses: {
              '200': { description: 'M3U playlist', content: { 'audio/x-mpegurl': {} } },
            },
          },
        },
      ],
    ]),
    components: {
      schemas: {
        Manifest: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            version: { type: 'string' },
            generated_at: { type: 'string', format: 'date-time' },
            base_url: { type: ['string', 'null'] },
            counts: { type: 'object', additionalProperties: { type: 'integer' } },
            endpoints: { type: 'object', additionalProperties: { type: 'string' } },
          },
        },
        Channel: {
          type: 'object',
          required: ['id', 'name', 'country'],
          properties: {
            id: { type: 'string', example: 'BBCNews.uk' },
            name: { type: 'string' },
            alt_names: { type: 'array', items: { type: 'string' } },
            network: { type: ['string', 'null'] },
            owners: { type: 'array', items: { type: 'string' } },
            country: { type: 'string', example: 'GB' },
            categories: { type: 'array', items: { type: 'string' } },
            languages: { type: 'array', items: { type: 'string' } },
            is_nsfw: { type: 'boolean' },
            launched: { type: ['string', 'null'] },
            closed: { type: ['string', 'null'] },
            website: { type: ['string', 'null'] },
            logo: { type: ['string', 'null'] },
            score: {
              type: 'integer',
              minimum: 0,
              maximum: 100,
              description: 'Best rolling availability score across the channel’s streams',
            },
            online: { type: 'boolean' },
            streams: { type: 'array', items: { $ref: '#/components/schemas/Stream' } },
            guides: { type: 'array', items: { $ref: '#/components/schemas/Guide' } },
          },
        },
        Stream: {
          type: 'object',
          required: ['url'],
          properties: {
            channel: { type: ['string', 'null'] },
            feed: { type: ['string', 'null'] },
            title: { type: 'string' },
            url: { type: 'string', format: 'uri' },
            referrer: { type: ['string', 'null'] },
            user_agent: { type: ['string', 'null'] },
            quality: { type: ['string', 'null'], example: '1080p' },
            rank: { type: 'number', description: 'Sort weight; higher is better' },
            health: { $ref: '#/components/schemas/Health' },
          },
        },
        Health: {
          type: ['object', 'null'],
          properties: {
            status: {
              type: 'string',
              enum: ['online', 'offline', 'timeout', 'blocked', 'error', 'unknown'],
            },
            score: { type: 'number', minimum: 0, maximum: 100 },
            checked_at: { type: 'string', format: 'date-time' },
            last_online: { type: ['string', 'null'], format: 'date-time' },
            latency_ms: { type: ['integer', 'null'] },
            uptime: { type: 'number', description: 'Uptime percentage over recorded history' },
            media: {
              type: ['object', 'null'],
              properties: {
                width: { type: ['integer', 'null'] },
                height: { type: ['integer', 'null'] },
                resolution: { type: ['string', 'null'] },
                frame_rate: { type: ['number', 'null'] },
                bitrate: { type: ['integer', 'null'] },
                video_codec: { type: ['string', 'null'] },
                audio_codec: { type: ['string', 'null'] },
              },
            },
          },
        },
        Guide: {
          type: 'object',
          properties: {
            site: { type: 'string' },
            site_id: { type: 'string' },
            lang: { type: 'string' },
            confidence: { type: 'number', minimum: 0, maximum: 1 },
            method: { type: 'string', enum: ['upstream', 'exact', 'alias', 'fuzzy', 'manual'] },
          },
        },
        Country: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            flag: { type: 'string' },
            languages: { type: 'array', items: { type: 'string' } },
            channels: { type: 'integer' },
            online: { type: 'integer' },
          },
        },
        Language: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            channels: { type: 'integer' },
          },
        },
        Category: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            description: { type: 'string' },
            channels: { type: 'integer' },
          },
        },
        Region: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            countries: { type: 'array', items: { type: 'string' } },
          },
        },
        Subdivision: {
          type: 'object',
          properties: {
            code: { type: 'string' },
            name: { type: 'string' },
            country: { type: 'string' },
          },
        },
        Timezone: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            utc_offset: { type: 'string' },
            countries: { type: 'array', items: { type: 'string' } },
          },
        },
        HealthReport: {
          type: 'object',
          properties: {
            generated_at: { type: 'string', format: 'date-time' },
            total: { type: 'integer' },
            online: { type: 'integer' },
            offline: { type: 'integer' },
            healthy: { type: 'integer' },
            average_score: { type: 'number' },
            average_latency_ms: { type: ['integer', 'null'] },
            by_resolution: { type: 'object', additionalProperties: { type: 'integer' } },
          },
        },
        SearchIndex: {
          type: 'object',
          properties: {
            generated_at: { type: 'string', format: 'date-time' },
            fields: { type: 'array', items: { type: 'string' } },
            channels: {
              type: 'array',
              description: 'Positional rows matching `fields`, for a compact payload',
              items: { type: 'array' },
            },
          },
        },
      },
    },
  };
}
