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

import got, {
  CancelableRequest,
  Got,
  HandlerFunction,
  Progress,
  Request,
} from 'got';
import { ClientRequest } from 'node:http';

// Phase timeouts alone never fire on a gateway that trickles bytes, so every
// probe also gets a total per-attempt deadline.
export const PROBE_TIMEOUT = {
  lookup: 5000,
  connect: 5000,
  secureConnect: 2000,
  socket: 7000,
  request: 30000,
};

/**
 * Aborts a response once its body exceeds `options.context.downloadLimit`
 * bytes. Requests with a limit are sent uncompressed and not decompressed:
 * got stops reporting progress once the compressed Content-Length is
 * reached, so a decompressed body could otherwise grow past the limit.
 */
export const downloadLimitHandler: HandlerFunction = (options, next) => {
  const limit = options.context.downloadLimit;
  if (typeof limit !== 'number') {
    return next(options);
  }

  options.decompress = false;
  options.headers = { ...options.headers, 'accept-encoding': 'identity' };
  const result = next(options);
  const message = `Response body exceeded ${limit} bytes`;
  // got reports progress once before reading the body, with `total` from
  // Content-Length. A body that arrives in one read jumps straight to 100%
  // and gets no further event until it is complete, so the declared size
  // must be checked up front. Chunked bodies have no total and report
  // every read.
  const exceeded = (progress: Progress) =>
    progress.transferred > limit ||
    (progress.total !== undefined && progress.total > limit);
  if (options.isStream) {
    const stream = result as Request;
    stream.on('downloadProgress', (progress: Progress) => {
      if (exceeded(progress)) {
        stream.destroy(new Error(message));
      }
    });
  } else {
    // cancel() would reject with a generic CancelError; destroying the
    // underlying request keeps the reason in the rejection.
    const promise = result as CancelableRequest;
    let clientRequest: ClientRequest | undefined;
    promise.on('request', (request: ClientRequest) => {
      clientRequest = request;
    });
    promise.on('downloadProgress', (progress: Progress) => {
      if (exceeded(progress)) {
        clientRequest?.destroy(new Error(message));
      }
    });
  }
  return result;
};

export function createGatewayHttpClient(nodeReleaseVersion: string): Got {
  return got.extend({
    headers: { 'X-AR-IO-Node-Release': nodeReleaseVersion },
    timeout: PROBE_TIMEOUT,
    handlers: [downloadLimitHandler],
  });
}
