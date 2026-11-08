/**
 * AR.IO Observer
 * Copyright (C) 2026 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import Arweave from 'arweave';
import { expect } from 'chai';
import nock from 'nock';
import { randomBytes } from 'node:crypto';
import winston from 'winston';

import { seedReportChunks } from './arweave-report-sink.js';

describe('seedReportChunks', () => {
  afterEach(() => nock.cleanAll());

  it('waits for mining and re-posts only chunks no live peer serves', async function () {
    this.timeout(30000);
    const uploadArweave = Arweave.init({
      host: 'upload-node.test',
      port: 1984,
      protocol: 'http',
    });
    const walletJwk = await uploadArweave.wallets.generate();
    const data = randomBytes(300_000);
    const transaction = await uploadArweave.createTransaction(
      { data, last_tx: 'a'.repeat(43), reward: '1' },
      walletJwk,
    );
    await uploadArweave.transactions.sign(transaction, walletJwk);

    const txEnd = 5_000_000n;
    const txStart = txEnd - BigInt(data.length) + 1n;
    const firstEnd = txStart + 262_144n - 1n;
    nock('http://upload-node.test:1984')
      .get(`/tx/${transaction.id}/offset`)
      .reply(404)
      .get(`/tx/${transaction.id}/offset`)
      .reply(200, { offset: txEnd.toString(), size: String(data.length) })
      .get('/peers')
      .reply(200, ['dead.test:1984', 'peer.test:1984']);
    nock('http://dead.test:1984').get('/info').replyWithError('refused');
    const posted: { data_root: string; offset: string; chunk: string }[] = [];
    nock('http://peer.test:1984')
      .get('/info')
      .reply(200, {})
      .get(`/chunk/${firstEnd}`)
      .reply(200, {})
      .get(`/chunk/${txEnd}`)
      .reply(404)
      .post('/chunk')
      .reply(303, (_uri, body) => {
        posted.push(body as (typeof posted)[number]);
        return '';
      });

    await seedReportChunks({
      uploadArweave,
      transaction,
      data,
      log: winston.createLogger({ silent: true }),
      pollIntervalMs: 1,
    });

    expect(posted).to.have.length(1);
    expect(posted[0].data_root).to.equal(transaction.data_root);
    expect(
      Buffer.from(posted[0].chunk, 'base64url').equals(data.subarray(262_144)),
    ).to.equal(true);
    expect(nock.isDone()).to.equal(true);
  });
});
