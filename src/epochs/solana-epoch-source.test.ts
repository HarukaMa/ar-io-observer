/**
 * AR.IO Gateway
 * Copyright (C) 2022-2025 Permanent Data Solutions, Inc. All Rights Reserved.
 *
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
import { expect } from 'chai';
import * as sinon from 'sinon';
import * as winston from 'winston';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createSolanaRpc } from '@solana/kit';
import {
  getEpochDecoder,
  getEpochEncoder,
  getEpochSize,
} from '@ar.io/solana-contracts/gar';

import { SolanaEpochSource } from './solana-epoch-source.js';

function makeLog(): winston.Logger {
  const noop = sinon.stub();
  return {
    child: () => ({
      verbose: noop,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    }),
    verbose: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as any;
}

/**
 * SolanaEpochSource fetches the on-chain `EpochSettings` PDA via
 * `fetchEncodedAccount` (from `@solana/kit`) and decodes via
 * `deserializeEpochSettingsFull` (from `@ar.io/sdk/solana`). Both are
 * module-level imports — stubbing them at the unit boundary requires
 * deeper module mocking than is worth doing for the timestamp-math
 * surface.
 *
 * Instead, we substitute the private `fetchSettings` method to inject
 * known on-chain state and verify:
 *   - timestamp math (epochIndex N → start = genesis + N*duration)
 *   - off-by-one resolution (currentEpochIndex - 1 is the active epoch)
 *   - cache TTL + epoch-end-aware invalidation
 *
 * The real PDA fetch path is exercised end-to-end by the running
 * observer (logs `Epoch params resolved`).
 */
function makeSource(opts: {
  currentEpochIndex: number;
  genesisTimestamp: number;
  epochDuration: number;
  cacheTtlMs?: number;
}): { src: SolanaEpochSource; fetchStub: sinon.SinonStub } {
  const src = new SolanaEpochSource({
    rpc: {} as any,
    garProgramAddress: 'AF8QAEaR4hzsqeUDwEdeTXMYtdyFegTENBdnJro6WVLR' as any,
    log: makeLog(),
    cacheTtlMs: opts.cacheTtlMs,
  });
  const fetchStub = sinon.stub().resolves({
    currentEpochIndex: opts.currentEpochIndex,
    genesisTimestamp: opts.genesisTimestamp,
    epochDuration: opts.epochDuration,
  });
  // Inject the stub at the private boundary.
  (src as any).fetchSettings = fetchStub;
  return { src, fetchStub };
}

describe('SolanaEpochSource', () => {
  describe('getEpochSettings', () => {
    it('converts on-chain seconds to milliseconds', async () => {
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      const s = await src.getEpochSettings();
      expect(s.epochZeroStartTimestamp).to.equal(1_700_000_000 * 1000);
      expect(s.durationMs).to.equal(3_600_000);
    });
  });

  describe('getEpochParams', () => {
    it('resolves the active epoch as currentEpochIndex - 1', async () => {
      // current = 18 means "next to be created" — active is 17.
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      const p = await src.getEpochParams();
      expect(p.epochIndex).to.equal(17);
      expect(p.epochStartTimestamp).to.equal(
        (1_700_000_000 + 17 * 3600) * 1000,
      );
      expect(p.epochEndTimestamp).to.equal((1_700_000_000 + 18 * 3600) * 1000);
      expect(p.epochStartHeight).to.equal(0);
    });

    it('clamps active epoch to 0 when currentEpochIndex is 0 (genesis edge)', async () => {
      const { src } = makeSource({
        currentEpochIndex: 0,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      const p = await src.getEpochParams();
      expect(p.epochIndex).to.equal(0);
    });

    it('caches params within cacheTtlMs (only one RPC for repeat calls)', async () => {
      const futureGenesis = Math.floor(Date.now() / 1000) - 60;
      const { src, fetchStub } = makeSource({
        currentEpochIndex: 2, // active epoch 1 starts ~now, ends ~hour from now
        genesisTimestamp: futureGenesis - 3600, // epoch 0 = past, epoch 1 = active
        epochDuration: 3600,
        cacheTtlMs: 10_000,
      });
      await src.getEpochParams();
      await src.getEpochParams();
      await src.getEpochParams();
      expect(fetchStub.callCount).to.equal(1);
    });

    it('invalidates cache immediately when epochEndTimestamp has passed', async () => {
      const { src, fetchStub } = makeSource({
        currentEpochIndex: 1, // active = 0
        genesisTimestamp: Math.floor(Date.now() / 1000) - 10_000, // far past
        epochDuration: 1, // 1-second epochs → already ended
        cacheTtlMs: 60_000, // long ttl, cache shouldn't apply
      });
      await src.getEpochParams();
      await src.getEpochParams();
      expect(fetchStub.callCount).to.equal(2);
    });

    it('refetches after cacheTtlMs expires', async () => {
      const { src, fetchStub } = makeSource({
        currentEpochIndex: 2,
        genesisTimestamp: Math.floor(Date.now() / 1000) - 60,
        epochDuration: 1_000_000_000, // very far future end
        cacheTtlMs: 1,
      });
      await src.getEpochParams();
      await new Promise((r) => setTimeout(r, 5));
      await src.getEpochParams();
      expect(fetchStub.callCount).to.equal(2);
    });

    it('propagates errors from the underlying fetch', async () => {
      const { src } = makeSource({
        currentEpochIndex: 1,
        genesisTimestamp: 0,
        epochDuration: 3600,
      });
      (src as any).fetchSettings = sinon
        .stub()
        .rejects(new Error('PDA not found'));
      let threw = false;
      try {
        await src.getEpochParams();
      } catch (e: any) {
        threw = true;
        expect(e.message).to.match(/not found/);
      }
      expect(threw).to.equal(true);
    });
  });

  describe('finalized prescriptions', () => {
    const program = 'AF8QAEaR4hzsqeUDwEdeTXMYtdyFegTENBdnJro6WVLR';
    const observer = '2yCUx5edFvUrkibYaUa2ZXWyx9kuJkS8CwyzsgHPWdZZ';
    const epoch = getEpochDecoder().decode(new Uint8Array(getEpochSize()));
    let missing = true;
    let owner = program;
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString());
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('id' in payload)
      ) {
        throw new Error('Invalid RPC request');
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: payload.id,
          result: {
            context: { slot: 1 },
            value: missing
              ? null
              : {
                  data: [
                    Buffer.from(getEpochEncoder().encode(epoch)).toString(
                      'base64',
                    ),
                    'base64',
                  ],
                  executable: false,
                  lamports: 1,
                  owner,
                  rentEpoch: 0,
                  space: getEpochSize(),
                },
          },
        }),
      );
    });
    let source: SolanaEpochSource;
    before(async () => {
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (address === null || typeof address === 'string')
        throw new Error('Missing RPC listener');
      source = new SolanaEpochSource({
        rpc: createSolanaRpc(`http://127.0.0.1:${address.port}`),
        garProgramAddress: program,
        log: winston.createLogger({ silent: true }),
      });
    });
    after(async () => {
      const closed = once(server, 'close');
      server.close();
      await closed;
    });

    it('waits for prescription completion and uses only counted observer identities', async () => {
      epoch.epochIndex = 7n;
      epoch.prescribedObservers[0] = observer;
      epoch.observerCount = 1;
      expect(await source.getObserverPrescription(7, observer)).to.equal(
        undefined,
      );
      missing = false;
      expect(await source.getObserverPrescription(7, observer)).to.equal(
        undefined,
      );
      epoch.prescriptionsDone = 1;
      expect(await source.getObserverPrescription(7, observer)).to.equal(true);
      epoch.observerCount = 0;
      expect(await source.getObserverPrescription(7, observer)).to.equal(false);
      epoch.observerCount = 1;
      epoch.prescribedObservers[0] = program;
      epoch.prescribedObserverGateways[0] = observer;
      expect(await source.getObserverPrescription(7, observer)).to.equal(false);
      owner = observer;
      let error: unknown;
      try {
        await source.getObserverPrescription(7, observer);
      } catch (caught) {
        error = caught;
      }
      expect(error)
        .to.be.instanceOf(Error)
        .with.property('message', 'Epoch account owner mismatch');
    });
  });

  describe('convenience methods', () => {
    it('getEpochStartTimestamp / getEpochEndTimestamp / getEpochIndex delegate to getEpochParams', async () => {
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      expect(await src.getEpochStartTimestamp()).to.equal(
        (1_700_000_000 + 17 * 3600) * 1000,
      );
      expect(await src.getEpochEndTimestamp()).to.equal(
        (1_700_000_000 + 18 * 3600) * 1000,
      );
      expect(await src.getEpochIndex()).to.equal(17);
    });

    it('getEpochStartHeight always returns 0 (no Arweave dep)', async () => {
      const { src } = makeSource({
        currentEpochIndex: 18,
        genesisTimestamp: 1_700_000_000,
        epochDuration: 3600,
      });
      expect(await src.getEpochStartHeight()).to.equal(0);
    });
  });
});
