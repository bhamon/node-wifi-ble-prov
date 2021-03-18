'use strict';

const dbus = require('dbus-next');

const NS_WPA = 'fi.w1.wpa_supplicant1';
const NS_WPA_INTERFACE = `${NS_WPA}.Interface`;
const PATH_WPA = '/fi/w1/wpa_supplicant1';

function factory(_context) {
  const proto = {};

  async function createInterface(_ifName) {
    const dbWpa = await _context.bus.getProxyObject(NS_WPA, PATH_WPA);
    const dbWpaIf = dbWpa.getInterface(NS_WPA);

    await dbWpaIf.CreateInterface({
      Ifname: new dbus.Variant('s', _ifName)
    });
  }

  async function connect(_ifName, _config) {
    const dbWpa = await _context.bus.getProxyObject(NS_WPA, PATH_WPA);
    const dbWpaIf = dbWpa.getInterface(NS_WPA);

    const dbInterfacePath = await dbWpaIf.GetInterface(_ifName);
    const dbInterface = await _context.bus.getProxyObject(NS_WPA, dbInterfacePath);
    const dbInterfaceIf = dbInterface.getInterface(NS_WPA_INTERFACE);

    const network = {
      key_mgmt: new dbus.Variant('s', 'NONE'),
      ssid: new dbus.Variant('s', _config.ssid)
    };

    if (_config.security) {
      switch (_config.security.type) {
        case 'wpa-psk':
          network.key_mgmt = new dbus.Variant('s', 'WPA-PSK');
          network.psk = new dbus.Variant('s', _config.security.psk);
          break;
        default:
          throw new Error(`unknown security type=${_config.security.type}`);
      }
    }

    const dbNetwork = await dbInterfaceIf.AddNetwork(network);
    await dbInterfaceIf.SelectNetwork(dbNetwork);
  }

  Object.defineProperties(proto, {
    createInterface: {value: createInterface},
    connect: {value: connect}
  });

  return proto;
}

module.exports = factory;
