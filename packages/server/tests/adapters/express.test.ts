import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';
import { createProvider } from '@chatcops/core';

vi.mock('@chatcops/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chatcops/core')>();
  return {
    ...actual,
    createProvider: vi.fn().mockResolvedValue({
      name: 'test-provider',
      async *chat() {
        yield 'Hello';
      },
      async chatSync() {
        return 'Hello';
      },
    }),
  };
});

import { chatcopsAnalyticsHandler, chatcopsMiddleware } from '../../src/adapters/express.js';
import type { ChatCopsServerConfig } from '../../src/config.js';

const mockedCreateProvider = vi.mocked(createProvider);

function createRequest(method: string, body?: unknown): Request {
  return {
    method,
    body,
    ip: '127.0.0.1',
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as Request;
}

type FakeResponse = {
  statusCode: number;
  headers: Record<string, unknown>;
  chunks: string[];
  body: unknown;
  ended: boolean;
  setHeader: (name: string, value: unknown) => void;
  status: (code: number) => FakeResponse;
  json: (payload: unknown) => FakeResponse;
  write: (chunk: string) => boolean;
  end: () => FakeResponse;
};

function createResponse(): { fake: FakeResponse; res: Response } {
  const fake: FakeResponse = {
    statusCode: 200,
    headers: {},
    chunks: [],
    body: undefined,
    ended: false,
    setHeader: (name, value) => {
      fake.headers[name] = value;
    },
    status: (code) => {
      fake.statusCode = code;
      return fake;
    },
    json: (payload) => {
      fake.body = payload;
      return fake;
    },
    write: (chunk) => {
      fake.chunks.push(chunk);
      return true;
    },
    end: () => {
      fake.ended = true;
      return fake;
    },
  };
  return { fake, res: fake as unknown as Response };
}

describe('express analytics sharing', () => {
  let setIntervalSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
  });

  afterEach(() => {
    for (const result of setIntervalSpy.mock.results) {
      clearInterval(result.value as ReturnType<typeof setInterval>);
    }
    vi.restoreAllMocks();
  });

  it('returns 204 and the configured CORS headers for OPTIONS', async () => {
    const config: ChatCopsServerConfig = {
      provider: { type: 'claude', apiKey: 'test-key' },
      systemPrompt: 'Test',
      cors: 'https://example.com',
    };
    const middleware = chatcopsMiddleware(config);
    const { fake, res } = createResponse();

    await middleware(createRequest('OPTIONS'), res, (() => undefined) as NextFunction);

    expect(fake.statusCode).toBe(204);
    expect(fake.headers).toMatchObject({
      'Access-Control-Allow-Origin': 'https://example.com',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    expect(fake.ended).toBe(true);
  });

  it('returns 405 JSON for methods other than POST and OPTIONS', async () => {
    const config: ChatCopsServerConfig = {
      provider: { type: 'claude', apiKey: 'test-key' },
      systemPrompt: 'Test',
      cors: '*',
    };
    const middleware = chatcopsMiddleware(config);
    const { fake, res } = createResponse();

    await middleware(createRequest('GET'), res, (() => undefined) as NextFunction);

    expect(fake.statusCode).toBe(405);
    expect(fake.body).toEqual({ error: 'Method not allowed' });
  });

  it('streams chunks, a done event, and closes the response for POST', async () => {
    const config: ChatCopsServerConfig = {
      provider: { type: 'claude', apiKey: 'test-key' },
      systemPrompt: 'Test',
      cors: '*',
    };
    const middleware = chatcopsMiddleware(config);
    const { fake, res } = createResponse();

    await middleware(
      createRequest('POST', { conversationId: 'streaming', message: 'Hello' }),
      res,
      (() => undefined) as NextFunction
    );

    expect(fake.headers).toMatchObject({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });
    expect(fake.chunks).toEqual([
      'data: {"content":"Hello"}\n\n',
      'data: {"done":true}\n\n',
      'data: [DONE]\n\n',
    ]);
    expect(fake.ended).toBe(true);
  });

  it('writes an internal error event and still ends when the handler throws', async () => {
    mockedCreateProvider.mockRejectedValueOnce(new Error('provider unavailable'));
    const config: ChatCopsServerConfig = {
      provider: { type: 'claude', apiKey: 'test-key' },
      systemPrompt: 'Test',
      cors: '*',
    };
    const middleware = chatcopsMiddleware(config);
    const { fake, res } = createResponse();

    await middleware(
      createRequest('POST', { conversationId: 'error', message: 'Hello' }),
      res,
      (() => undefined) as NextFunction
    );

    expect(fake.chunks).toEqual(['data: {"error":"internal_error"}\n\n']);
    expect(fake.ended).toBe(true);
  });

  it('reports middleware traffic through chatcopsAnalyticsHandler', async () => {
    const config: ChatCopsServerConfig = {
      provider: { type: 'claude', apiKey: 'test-key' },
      systemPrompt: 'Test',
      cors: '*',
      analytics: true,
    };

    const middleware = chatcopsMiddleware(config);

    for (const conversationId of ['conv-1', 'conv-2']) {
      const { fake, res } = createResponse();
      await middleware(
        createRequest('POST', { conversationId, message: 'Hello' }),
        res,
        (() => undefined) as NextFunction
      );
      expect(fake.chunks.join('')).toContain('data: [DONE]');
      expect(fake.ended).toBe(true);
    }

    const { fake: statsFake, res: statsRes } = createResponse();
    chatcopsAnalyticsHandler(config)(createRequest('GET'), statsRes);

    expect(statsFake.body).toMatchObject({ totalConversations: 2 });
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
