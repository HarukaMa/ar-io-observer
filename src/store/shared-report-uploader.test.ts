/**
 * AR.IO Gateway
 * Copyright (C) 2026 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import type { TurboAuthenticatedClient } from '@ardrive/turbo-sdk/node';
import { ArweaveSigner, DataItem } from '@dha-team/arbundles/node';
import Arweave from 'arweave';
import { expect } from 'chai';
import nock from 'nock';
import { gunzipSync } from 'node:zlib';
import winston from 'winston';

import { ObserverReport } from '../types.js';
import { ArweaveReportSink } from './arweave-report-sink.js';
import { TurboReportSink } from './turbo-report-sink.js';

for (const mode of ['arweave', 'turbo'] as const) {
  describe(`${mode} shared report uploader`, () => {
    afterEach(() => nock.cleanAll());

    it('uploads separate observer reports and reuses only that observer report', async function () {
      this.timeout(30000);
      const arweave = Arweave.init({
        host: 'report-store.test',
        port: 443,
        protocol: 'https',
      });
      const uploadArweave = Arweave.init({
        host: 'upload-node.test',
        port: 1984,
        protocol: 'http',
      });
      const walletJwk = await arweave.wallets.generate();
      const log = winston.createLogger({ silent: true });
      const uploads: {
        id: string;
        tags: { name: string; value: string }[];
        report: ObserverReport;
      }[] = [];
      nock('https://report-store.test')
        .persist()
        .post('/graphql')
        .reply((_uri, body): [number, object] => {
          // Nock receives the JSON request constructed by the sink.
          const request = body as { query: string };
          const tags = [
            ...request.query.matchAll(
              /name:\s*"([^"]+)",\s*values:\s*\[\s*"([^"]+)"\s*\]/g,
            ),
          ];
          const match = uploads.find((upload) =>
            tags.every(([, name, value]) =>
              upload.tags.some(
                (tag) => tag.name === name && tag.value === value,
              ),
            ),
          );
          return [
            200,
            {
              data: {
                transactions: {
                  edges: match ? [{ node: { id: match.id } }] : [],
                },
              },
            },
          ];
        });
      nock('http://upload-node.test:1984')
        .persist()
        .get('/tx_anchor')
        .reply(200, 'a'.repeat(43))
        .get(/\/price\//)
        .reply(200, '1000')
        .post('/tx')
        .reply((_uri, body): [number, string] => {
          // Nock receives a serialized transaction from arweave-js.
          const transaction = body as {
            id: string;
            data: string;
            tags: { name: string; value: string }[];
          };
          uploads.push({
            id: transaction.id,
            tags: transaction.tags.map((tag) => ({
              name: Buffer.from(tag.name, 'base64url').toString(),
              value: Buffer.from(tag.value, 'base64url').toString(),
            })),
            report: JSON.parse(
              gunzipSync(Buffer.from(transaction.data, 'base64url')).toString(),
            ),
          });
          return [200, 'OK'];
        });
      const turboClient = {
        uploadSignedDataItem: async (input: {
          dataItemStreamFactory: () => Buffer;
        }) => {
          const item = new DataItem(input.dataItemStreamFactory());
          uploads.push({
            id: item.id,
            tags: item.tags,
            report: JSON.parse(gunzipSync(item.rawData).toString()),
          });
          return { id: item.id };
        },
        getBalance: async () => ({ winc: '0' }),
      };
      // The fixture implements only the client methods used by this sink.
      const client = turboClient as unknown as TurboAuthenticatedClient;
      const sink =
        mode === 'arweave'
          ? new ArweaveReportSink({ arweave, uploadArweave, walletJwk, log })
          : new TurboReportSink({
              arweave,
              signer: new ArweaveSigner(walletJwk),
              turboClient: client,
              log,
            });
      const report = (observerAddress: string): ObserverReport => ({
        formatVersion: 1,
        observerAddress,
        epochIndex: 584,
        epochStartTimestamp: 1792800250000,
        epochEndTimestamp: 1792886650000,
        epochStartHeight: 0,
        generatedAt: 1792880200,
        gatewayAssessments: {},
      });
      const first = await sink.saveReport({ report: report('observer-one') });
      const second = await sink.saveReport({ report: report('observer-two') });
      expect(second.reportTxId).not.to.equal(first.reportTxId);
      const retry = await sink.saveReport({ report: report('observer-one') });
      expect(retry.reportTxId).to.equal(first.reportTxId);
      expect(
        uploads.map((upload) => upload.report.observerAddress),
      ).to.deep.equal(['observer-one', 'observer-two']);
    });
  });
}
