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
import Arweave from 'arweave';
import type TransactionModule from 'arweave/node/lib/transaction.js';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import zlib from 'node:zlib';
import * as winston from 'winston';

import { REPORT_FORMAT_VERSION } from '../observer.js';
import { ObserverReport, ReportInfo, ReportSink } from '../types.js';

const gzip = promisify(zlib.gzip);

async function requestStatus(
  url: string,
  timeoutMs: number,
  init: RequestInit = {},
): Promise<number | undefined> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return undefined;
  }
}

/**
 * A node without storage modules keeps posted data only until it is passed
 * on, so once the report is mined, re-post any chunk that a sample of the
 * upload node's peers cannot serve. Nodes reject chunks whose proof does
 * not match the mined data_root and answer 303 for chunks they already hold.
 */
export async function seedReportChunks({
  uploadArweave,
  transaction,
  data,
  log,
  pollIntervalMs = 60_000,
  deadlineMs = 2 * 60 * 60_000,
  peerCount = 5,
  requestTimeoutMs = 10_000,
}: {
  uploadArweave: Arweave;
  transaction: TransactionModule.default;
  data: Uint8Array;
  log: winston.Logger;
  pollIntervalMs?: number;
  deadlineMs?: number;
  peerCount?: number;
  requestTimeoutMs?: number;
}): Promise<void> {
  const txId = transaction.id;
  const deadline = Date.now() + deadlineMs;
  let mined: { offset: unknown; size: unknown } | undefined;
  for (;;) {
    const response = await uploadArweave.api
      .get<unknown>(`tx/${txId}/offset`)
      .catch(() => undefined);
    const body = response?.data;
    if (
      response?.status === 200 &&
      typeof body === 'object' &&
      body !== null &&
      'offset' in body &&
      'size' in body
    ) {
      mined = body;
      break;
    }
    if (Date.now() + pollIntervalMs > deadline) {
      log.warn('Report not mined before chunk seeding deadline', { txId });
      return;
    }
    await delay(pollIntervalMs, undefined, { ref: false });
  }
  if (
    typeof mined.offset !== 'string' ||
    !/^\d+$/.test(mined.offset) ||
    mined.size !== String(data.byteLength)
  ) {
    log.warn('Mined report geometry does not match uploaded data', {
      txId,
      offset: mined.offset,
      size: mined.size,
    });
    return;
  }
  const txStart = BigInt(mined.offset) - BigInt(mined.size) + 1n;

  const listed = await uploadArweave.api
    .get<unknown>('peers')
    .catch(() => undefined);
  const candidates = Array.isArray(listed?.data)
    ? listed.data.filter((peer): peer is string => typeof peer === 'string')
    : [];
  const peers: string[] = [];
  for (const peer of candidates.slice(0, peerCount * 4)) {
    if (peers.length >= peerCount) break;
    if (
      (await requestStatus(`http://${peer}/info`, requestTimeoutMs)) === 200
    ) {
      peers.push(peer);
    }
  }
  if (peers.length === 0) {
    log.warn('No responsive peers to check report chunks', { txId });
    return;
  }

  await transaction.prepareChunks(data);
  const chunks = transaction.chunks?.chunks ?? [];
  let missing = 0;
  let unseeded = 0;
  for (let index = 0; index < chunks.length; index++) {
    const end = txStart + BigInt(chunks[index].maxByteRange) - 1n;
    const found = await Promise.all(
      peers.map((peer) =>
        requestStatus(`http://${peer}/chunk/${end}`, requestTimeoutMs),
      ),
    );
    if (found.includes(200)) continue;
    missing++;
    const body = JSON.stringify(transaction.getChunk(index, data));
    const posted = await Promise.all(
      peers.map((peer) =>
        requestStatus(`http://${peer}/chunk`, requestTimeoutMs, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        }),
      ),
    );
    if (!posted.some((status) => status === 200 || status === 303)) {
      unseeded++;
    }
  }
  const summary = { txId, chunks: chunks.length, missing, unseeded, peers };
  if (unseeded > 0) {
    log.warn('Report chunks could not be seeded', summary);
  } else {
    log.verbose('Report chunks checked', summary);
  }
}

export class ArweaveReportSink implements ReportSink {
  // Dependencies
  private log: winston.Logger;
  private arweave: Arweave;
  private readonly walletJwk: any; // JWK wallet type
  private readonly seedChunks: boolean;

  constructor({
    log,
    arweave,
    walletJwk,
    seedChunks = false,
  }: {
    log: winston.Logger;
    arweave: Arweave;
    walletJwk: any;
    seedChunks?: boolean;
  }) {
    this.log = log.child({ class: this.constructor.name });
    this.arweave = arweave;
    this.walletJwk = walletJwk;
    this.seedChunks = seedChunks;
  }

  async saveReport(reportInfo: ReportInfo): Promise<ReportInfo> {
    const { report } = reportInfo;
    const log = this.log.child({
      epochStartTimestamp: report.epochStartTimestamp,
      epochIndex: report.epochIndex,
      epochStartHeight: report.epochStartHeight,
    });

    try {
      // Return existing TX ID if the report was already saved
      const existingTxId = await this.getReportTxId(report);
      if (existingTxId !== undefined) {
        log.verbose('Report already saved, skipping upload');
        return {
          ...reportInfo,
          reportTxId: existingTxId,
        };
      }

      // Compress the report data
      const reportBuffer = Buffer.from(JSON.stringify(report), 'utf-8');
      const gzipReportBuffer = await gzip(reportBuffer, { level: 9 });

      // Create and configure the transaction
      const transaction = await this.arweave.createTransaction(
        { data: gzipReportBuffer },
        this.walletJwk,
      );

      // Add tags
      transaction.addTag('App-Name', 'AR-IO Observer');
      transaction.addTag('App-Version', '0.0.1');
      transaction.addTag('Content-Type', 'application/json');
      transaction.addTag('Content-Encoding', 'gzip');
      transaction.addTag('AR-IO-Component', 'observer');
      transaction.addTag(
        'AR-IO-Epoch-Start-Height',
        report.epochStartHeight.toString(),
      );
      transaction.addTag(
        'AR-IO-Epoch-Start-Timestamp',
        report.epochStartTimestamp.toString(),
      );
      transaction.addTag('AR-IO-Epoch-Index', report.epochIndex.toString());
      transaction.addTag(
        'AR-IO-Observer-Report-Version',
        REPORT_FORMAT_VERSION.toString(),
      );

      // Sign transaction
      await this.arweave.transactions.sign(transaction, this.walletJwk);

      // Submit transaction
      const uploader = await this.arweave.transactions.getUploader(transaction);
      while (!uploader.isComplete) {
        await uploader.uploadChunk();
        log.debug(`Upload progress: ${uploader.pctComplete}%`);
      }

      log.verbose('Report saved to Arweave', { txId: transaction.id });

      if (this.seedChunks) {
        seedReportChunks({
          uploadArweave: this.uploadArweave,
          transaction,
          data: gzipReportBuffer,
          log,
        }).catch((error) =>
          log.warn('Report chunk seeding failed', {
            txId: transaction.id,
            error: `${error}`,
          }),
        );
      }

      return {
        ...reportInfo,
        reportTxId: transaction.id,
      };
    } catch (error) {
      throw new Error(`Error saving report: ${error}`);
    }
  }

  private async getReportTxId(
    report: ObserverReport,
  ): Promise<string | undefined> {
    const walletAddress = await this.arweave.wallets.jwkToAddress(
      this.walletJwk,
    );

    // Find the first report TX ID for the given epoch parameters and format version
    const queryObject = {
      query: `{
        transactions(
          sort: HEIGHT_ASC,
          first:1,
          owners: [ "${walletAddress}" ],
          tags: [
            { name: "App-Name", values: ["AR-IO Observer"] },
            { name: "Content-Type", values: [ "application/json" ] },
            { name: "AR-IO-Epoch-Start-Height", values: [ "${report.epochStartHeight}" ]},
            { name: "AR-IO-Epoch-Index", values: [ "${report.epochIndex}" ] },
            { name: "AR-IO-Epoch-Start-Timestamp", values: [ "${report.epochStartTimestamp}" ]},
            { name: "AR-IO-Observer-Report-Version", values: [ "${REPORT_FORMAT_VERSION}" ] }
          ]
        ) 
        {
          edges {
            node {
              id
            }
          }
        }
      }`,
    };

    const response = await this.arweave.api.post('/graphql', queryObject);

    // Return the first report TX ID if it exists
    const edges = response?.data?.data?.transactions?.edges;
    if (Array.isArray(edges)) {
      return edges[0]?.node?.id;
    } else {
      return undefined;
    }
  }
}
