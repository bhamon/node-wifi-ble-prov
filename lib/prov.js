'use strict';

const crypto = require('crypto');
const dbus = require('dbus-next');

const NS_PROPS = 'org.freedesktop.DBus.Properties';
const NS_OBJECT_MANAGER = 'org.freedesktop.DBus.ObjectManager';
const NS_BLUEZ = 'org.bluez';
const NS_BLUEZ_ADAPTER = `${NS_BLUEZ}.Adapter1`;
const NS_BLUEZ_ADV_MANAGER = `${NS_BLUEZ}.LEAdvertisingManager1`;
const NS_BLUEZ_GATT_MANAGER = `${NS_BLUEZ}.GattManager1`;
const NS_BLUEZ_GATT_SERVICE = `${NS_BLUEZ}.GattService1`;
const NS_BLUEZ_GATT_CHR = `${NS_BLUEZ}.GattCharacteristic1`;
const NS_BLUEZ_ERROR_FAILED = 'org.bluez.Error.Failed';
const DISCONNECT_CHALLENGE = 'disconnect';

function factory(_context) {
  const proto = {};
  let handler;
  let connectionWatch;

  async function getDefaultAdapter() {
    const dbBluez = await _context.bus.getProxyObject(NS_BLUEZ, '/');
    const dbBluezManager = dbBluez.getInterface(NS_OBJECT_MANAGER);
    const objects = await dbBluezManager.GetManagedObjects();
    for (const [path, interfaces] of Object.entries(objects)) {
      if (Object.keys(interfaces).includes(NS_BLUEZ_ADAPTER)) {
        return await _context.bus.getProxyObject(NS_BLUEZ, path);
      }
    }

    throw new Error('default adapter not found');
  }

  async function isPowered() {
    const dbAdapter = await getDefaultAdapter();
    const dbAdapterProps = dbAdapter.getInterface(NS_PROPS);
    const dbPowered = await dbAdapterProps.Get(NS_BLUEZ_ADAPTER, 'Powered');
    return dbPowered.value;
  }

  async function setPower(_enabled) {
    const dbAdapter = await getDefaultAdapter();
    const dbAdapterProps = dbAdapter.getInterface(NS_PROPS);
    await dbAdapterProps.Set(NS_BLUEZ_ADAPTER, 'Powered', new dbus.Variant('b', _enabled));
  }

  function decrypt(_context, _iv, _data) {
    const iv = Buffer.from(_iv, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-cbc', _context.localKey, iv);
    let decrypted = decipher.update(_data, 'base64');
    decrypted += decipher.final();

    return decrypted;
  }

  async function install(_path, _localName) {
    if (handler) {
      throw new Error('already installed');
    }

    const pathAdv = `${_path}/adv`;
    const pathProv = `${_path}/prov`;

    const service = {
      primary: true,
      uuid: 'c607d27b-8541-4947-0000-47258ea5e9d7',
      characteristics: {
        connected: {
          uuid: 'c607d27b-8541-4947-0001-47258ea5e9d7',
          flags: ['notify', 'read'],
          async startNotify(_notify) {
            if (connectionWatch) {
              return;
            }

            connectionWatch = await _context.nm.watchConnectionStatus();
            connectionWatch.on('status', _status => {
              _notify(Buffer.from([_status.connected ? 0x01 : 0x00]));
            });
          },
          async stopNotify() {
            if (!connectionWatch) {
              return;
            }

            connectionWatch.close();
            connectionWatch = null;
          },
          async read() {
            let connected;
            if (connectionWatch) {
              connected = connectionWatch.connected;
            } else {
              const status = await _context.nm.getConnectionStatus();
              connected = status.connected;
            }

            return Buffer.from([connected ? 0x01 : 0x00]);
          }
        },
        mac: {
          uuid: 'c607d27b-8541-4947-0002-47258ea5e9d7',
          flags: ['read'],
          async read() {
            const mac = await _context.nm.getMac();
            return Buffer.from(mac);
          }
        },
        ap: {
          uuid: 'c607d27b-8541-4947-0003-47258ea5e9d7',
          flags: ['read'],
          async read() {
            const status = await _context.nm.getConnectionStatus();
            if (!status.connected) {
              return Buffer.from([]);
            }

            return Buffer.from(JSON.stringify({
              ssid: status.ssid,
              frequency: status.frequency,
              strength: status.strength
            }));
          }
        },
        command: {
          uuid: 'c607d27b-8541-4947-0004-47258ea5e9d7',
          flags: ['write'],
          async write(_data) {
            const command = JSON.parse(_data.toString());
            switch (command.type) {
              case 'connect': {
                const iv = Buffer.from(command.iv, 'base64');
                const ssid = decrypt(_context, iv, command.ssid);
                let security = null;
                if (command.security) {
                  switch (command.security.type) {
                    case 'wpa-psk': {
                      const psk = decrypt(_context, iv, command.security.psk);
                      security = {
                        type: 'wpa-psk',
                        psk
                      };
                      break;
                    }
                    default:
                      throw new Error(`unknown security type=${command.security.type}`);
                  }
                }

                await _context.nm.connect(ssid, security);
                break;
              }
              case 'disconnect': {
                const iv = Buffer.from(command.iv, 'base64');
                const challenge = decrypt(_context, iv, command.challenge);
                if (challenge !== DISCONNECT_CHALLENGE) {
                  throw new Error('invalid challenge');
                }

                await _context.nm.disconnect();
                break;
              }
              default:
                throw new Error(`unknown command type=${command.type}`);
            }
          }
        }
      }
    };

    handler = function(_msg) {
      _context.log.debug({msg: _msg});

      switch (_msg.path) {
        case pathAdv:
          switch (_msg.interface) {
            case NS_PROPS:
              switch (_msg.member) {
                case 'GetAll':
                  _context.bus.send(dbus.Message.newMethodReturn(_msg, 'a{sv}', [{
                    Type: new dbus.Variant('s', 'peripheral'),
                    ServiceUUIDs: new dbus.Variant('as', [
                      service.uuid
                    ]),
                    LocalName: new dbus.Variant('s', _localName),
                    IncludeTxPower: new dbus.Variant('b', true)
                  }]));
                  return true;
              }
          }
          break;
        case pathProv:
          switch (_msg.interface) {
            case NS_OBJECT_MANAGER:
              switch (_msg.member) {
                case 'GetManagedObjects': {
                  const objs = {};

                  objs[pathProv] = {
                    [NS_PROPS]: {},
                    [NS_BLUEZ_GATT_SERVICE]: {
                      Primary: new dbus.Variant('b', service.primary),
                      UUID: new dbus.Variant('s', service.uuid)
                    }
                  };

                  for (const [key, characteristic] of Object.entries(service.characteristics)) {
                    objs[`${pathProv}/${key}`] = {
                      [NS_PROPS]: {},
                      [NS_BLUEZ_GATT_CHR]: {
                        UUID: new dbus.Variant('s', characteristic.uuid),
                        Service: new dbus.Variant('o', pathProv),
                        Flags: new dbus.Variant('as', characteristic.flags)
                      }
                    };
                  }

                  _context.bus.send(dbus.Message.newMethodReturn(_msg, 'a{oa{sa{sv}}}', [objs]));
                  return true;
                }
              }
              break;
          }
          break;
        default: {
          const prefix = `${pathProv}/`;
          if (!_msg.path.startsWith(prefix)) {
            return;
          }

          switch (_msg.interface) {
            case NS_BLUEZ_GATT_CHR: {
              const key = _msg.path.substr(prefix.length);
              const characteristic = service.characteristics[key];
              if (!characteristic) {
                _context.log.error({msg: _msg}, 'unknown characteristic');
                return;
              }

              switch (_msg.member) {
                case 'StartNotify': {
                  if (!characteristic.startNotify) {
                    _context.log.error({msg: _msg}, 'missing start notify handler');
                    return;
                  }

                  const notify = function(_value) {
                    _context.bus.send(new dbus.Message({
                      destination: NS_BLUEZ,
                      path: _msg.path,
                      interface: NS_PROPS,
                      member: 'PropertiesChanged',
                      signature: 'sa{sv}as',
                      body: [
                        NS_BLUEZ_GATT_CHR,
                        {Value: new dbus.Variant('ay', _value)},
                        []
                      ]
                    }));
                  };

                  characteristic.startNotify(notify)
                    .catch(e => {
                      _context.log.error({err: e}, 'start notify handler error');
                      _context.dbus.send(dbus.Message.newError(_msg, NS_BLUEZ_ERROR_FAILED));
                    });
                  return true;
                }
                case 'StopNotify':
                  if (!characteristic.stopNotify) {
                    _context.log.error({msg: _msg}, 'missing stop notify handler');
                    return;
                  }

                  characteristic.stopNotify()
                    .catch(e => {
                      _context.log.error({err: e}, 'stop notify handler error');
                      _context.dbus.send(dbus.Message.newError(_msg, NS_BLUEZ_ERROR_FAILED));
                    });
                  return true;
                case 'ReadValue':
                  if (!characteristic.read) {
                    _context.log.error({msg: _msg}, 'missing read handler');
                    return;
                  }

                  characteristic.read()
                    .then(_value => {
                      _context.bus.send(dbus.Message.newMethodReturn(_msg, 'ay', [_value]));
                    })
                    .catch(e => {
                      _context.log.error({err: e}, 'read handler error');
                      _context.dbus.send(dbus.Message.newError(_msg, NS_BLUEZ_ERROR_FAILED));
                    });
                  return true;
                case 'WriteValue':
                  if (!characteristic.write) {
                    _context.log.error({msg: _msg}, 'missing write handler');
                    return;
                  }

                  characteristic.write(_msg.body[0])
                    .then(() => {
                      _context.bus.send(dbus.Message.newMethodReturn(_msg, 'u', [0x00]));
                    })
                    .catch(e => {
                      _context.log.error({err: e}, 'write handler error');
                      _context.dbus.send(dbus.Message.newError(_msg, NS_BLUEZ_ERROR_FAILED));
                    });
                  return true;
              }
            }
          }
        }
      }
    };

    _context.bus.addMethodHandler(handler);

    const dbAdapter = await getDefaultAdapter();
    const dbAdapterProps = dbAdapter.getInterface(NS_PROPS);

    const dbPowered = await dbAdapterProps.Get(NS_BLUEZ_ADAPTER, 'Powered');
    if (!dbPowered.value) {
      await dbAdapterProps.Set(NS_BLUEZ_ADAPTER, 'Powered', new dbus.Variant('b', true));
    }

    const dbAdvManagerIf = dbAdapter.getInterface(NS_BLUEZ_ADV_MANAGER);
    const dbGattManagerIf = dbAdapter.getInterface(NS_BLUEZ_GATT_MANAGER);

    await dbGattManagerIf.RegisterApplication(pathProv, {});
    await dbAdvManagerIf.RegisterAdvertisement(pathAdv, {});
  }

  Object.defineProperties(proto, {
    isPowered: {value: isPowered},
    setPower: {value: setPower},
    install: {value: install}
  });

  return proto;
}

module.exports = factory;
