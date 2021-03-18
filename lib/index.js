'use strict';

const crypto = require('crypto');
const ajv = require('ajv');
const minimist = require('minimist');
const pino = require('pino');
const dbus = require('dbus-next');
const modelNm = require('./nm');
const modelProv = require('./prov');

const VALIDATOR_ARGS = new ajv.default({useDefaults: true}).compile({
  type: 'object',
  properties: {
    help: {type: 'boolean', default: false},
    ['local-key']: {
      type: 'string',
      pattern: '[0-9a-f]{64}',
      default: crypto.randomBytes(32).toString('hex')
    },
    ['local-name']: {
      type: 'string',
      default: 'wifi-prov'
    },
    level: {
      type: 'string',
      enum: ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'],
      default: 'info'
    }
  },
  required: ['help', 'local-key', 'level']
});

function printUsage() {
  console.log(`
NAME
  wifi-ble-prov.js

SYNOPSIS
  node wifi-ble-prov.js -k <LOCAL_KEY>

DESCRIPTION
  Exposes a WiFi provisioning service through BLE.
  The provided <LOCAL_KEY> is used to secure sensistive BLE exchanges (WiFi credentials).

  -h, --help
    Show this help message.
  -k, --local-key=<LOCAL_KEY>
    A hex-encoded AES256 key.
    Defaults to a randomly generated one.
  -n, --local-name=<LOCAL_NAME>
    BLE broadcasted name.
    Defaults to 'wifi-prov'.
  -l, --level=<LEVEL>
    Log level.
    One of ['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace'].
    Defaults to 'info'.
  `);
}

const args = minimist(process.argv.slice(2), {
  boolean: ['help'],
  strings: [
    'local-key',
    'local-name',
    'level'
  ],
  alias: {
    h: 'help',
    k: 'local-key',
    n: 'local-name',
    l: 'level'
  }
});

if (args.help) {
  printUsage();
  return;
}

if (!VALIDATOR_ARGS(args)) {
  printUsage();
  console.error(JSON.stringify(VALIDATOR_ARGS.errors));
  process.exitCode = 1;
  return;
}

const log = pino({level: args.level});
log.info({localKey: args['local-key']});

(async () => {
  const bus = dbus.systemBus();
  try {
    const nm = modelNm({
      log: log.child({module: 'nm'}),
      bus
    });

    const networkingEnabled = await nm.isNetworkingEnabled();
    if (!networkingEnabled) {
      await nm.setNetworkingState(true);
    }

    const wirelessEnabled = await nm.isWirelessEnabled();
    if (!wirelessEnabled) {
      await nm.setWirelessState(true);
    }

    const prov = modelProv({
      log: log.child({module: 'prov'}),
      bus,
      nm,
      localKey: Buffer.from(args['local-key'], 'hex')
    });

    const powered = await prov.isPowered();
    if (!powered) {
      await prov.setPower(true);
    }

    await prov.install('/com/braveCactus/wifiBleProv', args['local-name']);
  } catch (e) {
    bus.disconnect();
    throw e;
  }
})()
  .catch(e => {
    process.exitCode = 1;
    log.error({err: e});
  });
