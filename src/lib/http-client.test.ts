/**
 * AR.IO Observer
 * Copyright (C) 2023 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 */
import { expect } from 'chai';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import zlib from 'node:zlib';

import { createGatewayHttpClient } from './http-client.js';

describe('createGatewayHttpClient download limit', function () {
  let server: http.Server;
  let baseUrl: string;
  let lastAcceptEncoding: string | string[] | undefined;

  before(async function () {
    server = http.createServer((req, res) => {
      lastAcceptEncoding = req.headers['accept-encoding'];
      switch (req.url) {
        case '/fixed/200':
          res.end(Buffer.alloc(200, 1));
          break;
        case '/declared-1000': {
          // Declares an oversized body, sends part of it, then stalls:
          // only the declared size can trip the limit.
          res.writeHead(200, { 'content-length': 1000 });
          res.write(Buffer.alloc(100, 1));
          break;
        }
        case '/chunked': {
          // No Content-Length: progress has no known total.
          res.write(Buffer.alloc(150, 1));
          res.write(Buffer.alloc(150, 1));
          res.end();
          break;
        }
        case '/gzip-bomb': {
          // Ignores Accept-Encoding: identity.
          const body = zlib.gzipSync(Buffer.alloc(1024 * 1024));
          res.setHeader('content-encoding', 'gzip');
          res.setHeader('content-length', body.length);
          res.end(body);
          break;
        }
        default:
          res.statusCode = 404;
          res.end();
      }
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async function () {
    await new Promise((resolve) => server.close(resolve));
  });

  // Production retry settings: a retry can race the abort.
  const client = createGatewayHttpClient('test');
  const limited = { context: { downloadLimit: 200 } };

  it('accepts a body exactly at the limit', async function () {
    const response = await client.get(`${baseUrl}/fixed/200`, {
      ...limited,
      responseType: 'buffer',
    });
    expect(response.body.length).to.equal(200);
  });

  it('rejects a declared body over the limit before reading it', async function () {
    const error = await client
      .get(`${baseUrl}/declared-1000`, { ...limited, responseType: 'buffer' })
      .then(
        () => undefined,
        (e: Error) => e,
      );
    expect(error?.message).to.include('exceeded 200 bytes');
  });

  it('rejects a chunked body that grows past the limit', async function () {
    const error = await client
      .get(`${baseUrl}/chunked`, { ...limited, responseType: 'buffer' })
      .then(
        () => undefined,
        (e: Error) => e,
      );
    expect(error?.message).to.include('exceeded 200 bytes');
  });

  it('rejects a streamed body that grows past the limit', async function () {
    const error = await new Promise<Error | undefined>((resolve) => {
      const stream = client.stream.get(`${baseUrl}/chunked`, limited);
      stream.on('error', resolve);
      stream.on('end', () => resolve(undefined));
      stream.resume();
    });
    expect(error?.message).to.include('exceeded 200 bytes');
  });

  it('asks for identity and never decompresses a limited body', async function () {
    const response = await client.get(`${baseUrl}/gzip-bomb`, {
      context: { downloadLimit: 64 * 1024 },
      responseType: 'buffer',
    });
    expect(lastAcceptEncoding).to.equal('identity');
    // Raw gzip bytes, far smaller than the 1 MiB it would inflate to.
    expect(response.body.length).to.be.lessThan(64 * 1024);
    expect(response.body.subarray(0, 2)).to.deep.equal(
      Buffer.from([0x1f, 0x8b]),
    );
  });

  it('leaves requests without a limit unchanged', async function () {
    const response = await client.get(`${baseUrl}/gzip-bomb`, {
      responseType: 'buffer',
    });
    expect(response.body.length).to.equal(1024 * 1024);
  });
});
