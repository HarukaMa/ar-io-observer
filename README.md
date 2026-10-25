# ar-io-observer

An Express microservice that provides REST API and CLI tools to run randomized
observation reports against ar.io nodes.

## Getting Started

Requirements:

- `nvm`
- `yarn`

### Running Locally

#### CLI

Generating a report:

- `nvm use`
- `yarn observe`

#### Service

Starting the service:

- `nvm use`
- `yarn service`

You can check the service is running by running the command:

```shell
curl localhost:5050/ar-io/observer/healthcheck
{"uptime":2.555423702,"date":"2023-09-14T21:24:27.677Z","message":"Welcome to the Permaweb."}
```

The current report is accessible at the `/ar-io/observer/reports/current`
endpoint.

The continuous service waits for finalized epoch prescriptions before loading
gateways, names, entropy, or running assessments. Unprescribed observers stay idle
until the next epoch. Epoch watching, cranking, and cleanup keep running
independently.

### Report upload wallet

Report uploads can use a shared Arweave wallet while each observer keeps its
own Solana signer for on-chain submissions. Mount the Arweave JWK read-only and
configure:

```env
REPORT_DATA_SINK=arweave
ARWEAVE_UPLOAD_KEY_FILE=/app/wallets/report-uploader.json
ARWEAVE_UPLOAD_URL=https://arweave.net
```

Remove explicit `SOLANA_UPLOAD_*` and `ETHEREUM_UPLOAD_*` settings when selecting
an Arweave upload wallet. Keep the observer's Solana signing settings unchanged.
Direct uploads spend AR from the upload wallet. `REPORT_DATA_SINK=turbo` instead
uses that wallet's Turbo credits.
`ARWEAVE_UPLOAD_URL` can point at a trusted Arweave node, including an HTTP URL
with an explicit port. It defaults to `ARWEAVE_URL`. Keep `ARWEAVE_URL` on a
GraphQL-capable gateway for previous-report lookups.

Both upload paths tag reports with `AR-IO-Observer-Address` and include it in
previous-report lookups. Reports from different observers remain separate even
when the upload wallet and epoch match.

### Docker

Build and run the container:

```shell
docker build --build-arg NODE_VERSION=$(cat .nvmrc |cut -c2-8) --build-arg NODE_VERSION_SHORT=$(cat .nvmrc |cut -c2-3) . -t ar-io-observer
docker run -p 5050:5050 ar-io-observer
```
