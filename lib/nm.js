'use strict';

const events = require('events');
const dbus = require('dbus-next');

const NS_PROPS = 'org.freedesktop.DBus.Properties';
const NS_NM = 'org.freedesktop.NetworkManager';
const NS_NM_SETTINGS = `${NS_NM}.Settings`;
const NS_NM_SETTINGS_CONNECTION = `${NS_NM_SETTINGS}.Connection`;
const NS_NM_CONNECTION_ACTIVE = `${NS_NM}.Connection.Active`;
const NS_NM_DEVICE = `${NS_NM}.Device`;
const NS_NM_DEVICE_WIRELESS = `${NS_NM_DEVICE}.Wireless`;
const NS_NM_ACCESS_POINT = `${NS_NM}.AccessPoint`;
const PATH_NM = '/org/freedesktop/NetworkManager';
const PATH_NM_SETTINGS = `${PATH_NM}/Settings`;
const DEVICE_TYPE_WIFI = 2;
const DEVICE_STATE_ACTIVATED = 100;
const UUID_PROV_CONNECTION = 'e806a36c-7249-45c1-8872-ad19095807bd';
const ID_PROV_CONNECTION = 'pi-prov';

function factory(_context) {
  const proto = {};

  async function isNetworkingEnabled() {
    const dbNm = await _context.bus.getProxyObject(NS_NM, PATH_NM);
    const dbNmProps = dbNm.getInterface(NS_PROPS);
    const dbNetworkingEnabled = await dbNmProps.Get(NS_NM, 'NetworkingEnabled');
    return dbNetworkingEnabled.value;
  }

  async function setNetworkingState(_enabled) {
    const dbNm = await _context.bus.getProxyObject(NS_NM, PATH_NM);
    const dbNmProps = dbNm.getInterface(NS_PROPS);
    await dbNmProps.Set(NS_NM, 'NetworkingEnabled', new dbus.Variant('b', _enabled));
  }

  async function isWirelessEnabled() {
    const dbNm = await _context.bus.getProxyObject(NS_NM, PATH_NM);
    const dbNmProps = dbNm.getInterface(NS_PROPS);
    const dbWirelessEnabled = await dbNmProps.Get(NS_NM, 'WirelessEnabled');
    return dbWirelessEnabled.value;
  }

  async function setWirelessState(_enabled) {
    const dbNm = await _context.bus.getProxyObject(NS_NM, PATH_NM);
    const dbNmProps = dbNm.getInterface(NS_PROPS);
    await dbNmProps.Set(NS_NM, 'WirelessEnabled', new dbus.Variant('b', _enabled));
  }

  async function getWifiDevice() {
    const dbNm = await _context.bus.getProxyObject(NS_NM, PATH_NM);
    const dbNmIf = dbNm.getInterface(NS_NM);
    const devices = await dbNmIf.GetDevices();
    for (const device of devices) {
      const dbDevice = await _context.bus.getProxyObject(NS_NM, device);
      const dbDeviceProps = dbDevice.getInterface(NS_PROPS);

      const dbType = await dbDeviceProps.Get(NS_NM_DEVICE, 'DeviceType');
      if (dbType.value === DEVICE_TYPE_WIFI) {
        const dbIpIf = await dbDeviceProps.Get(NS_NM_DEVICE, 'IpInterface');
        const dbState = await dbDeviceProps.Get(NS_NM_DEVICE, 'State');
        const dbActiveConnection = await dbDeviceProps.Get(NS_NM_DEVICE, 'ActiveConnection');
        return {
          path: device,
          ipIf: dbIpIf.value,
          activated: dbState.value === DEVICE_STATE_ACTIVATED,
          activeConnection: dbActiveConnection.value
        };
      }
    }

    throw new Error('no wifi device found');
  }

  async function getMac() {
    const device = await getWifiDevice();
    const dbDevice = await _context.bus.getProxyObject(NS_NM, device.path);
    const dbDeviceProps = dbDevice.getInterface(NS_PROPS);
    const dbHwAddress = await dbDeviceProps.Get(NS_NM_DEVICE_WIRELESS, 'HwAddress');
    return dbHwAddress.value;
  }

  async function getConnectionStatus() {
    const device = await getWifiDevice();
    const status = {connected: device.activated};
    if (device.activated) {
      const dbDevice = await _context.bus.getProxyObject(NS_NM, device.path);
      const dbDeviceProps = dbDevice.getInterface(NS_PROPS);
      const dbActiveAccessPoint = await dbDeviceProps.Get(NS_NM_DEVICE_WIRELESS, 'ActiveAccessPoint');
      console.log(dbActiveAccessPoint.value);
      const dbAccessPoint = await _context.bus.getProxyObject(NS_NM, dbActiveAccessPoint.value);
      const dbAccessPointProps = dbAccessPoint.getInterface(NS_PROPS);
      const dbSsid = await dbAccessPointProps.Get(NS_NM_ACCESS_POINT, 'Ssid');
      const dbFrequency = await dbAccessPointProps.Get(NS_NM_ACCESS_POINT, 'Frequency');
      const dbStrength = await dbAccessPointProps.Get(NS_NM_ACCESS_POINT, 'Strength');

      status.ssid = dbSsid.value.toString();
      status.frequency = dbFrequency.value;
      status.strength = dbStrength.value;
    }

    return status;

    // const dbConnectionActive = await _context.bus.getProxyObject(NS_NM, device.activeConnection);
    // const dbConnectionActiveProps = dbConnectionActive.getInterface(NS_PROPS);
    // const dbConnection = await dbConnectionActiveProps.Get(NS_NM_CONNECTION_ACTIVE, 'Connection');
    // const dbSettingsConnection = await _context.bus.getProxyObject(NS_NM, dbConnection.value);
    // const dbSettingsConnectionIf = dbSettingsConnection.getInterface(NS_NM_SETTINGS_CONNECTION);
    // const settings = await dbSettingsConnectionIf.GetSettings();
    // return {
    //   connected: device.activated,
    //   ssid: settings['802-11-wireless'].ssid.value.toString()
    // };
  }

  async function watchConnectionStatus() {
    const device = await getWifiDevice();
    const dbDevice = await _context.bus.getProxyObject(NS_NM, device.path);
    const dbDeviceProps = dbDevice.getInterface(NS_PROPS);
    const watch = new events.EventEmitter();

    function onChange(_iFace, _changed) {
      if (_changed.State) {
        const activated = _changed.State.value === DEVICE_STATE_ACTIVATED;
        if (device.activated !== activated) {
          device.activated = _changed.State.value === DEVICE_STATE_ACTIVATED;
          watch.emit(device.activated ? 'connected' : 'disconnected');
          watch.emit('status', {connected: device.activated});
        }
      }
    }

    function close() {
      dbDeviceProps.off('PropertiesChanged', onChange);
    }

    dbDeviceProps.on('PropertiesChanged', onChange);

    Object.defineProperties(watch, {
      connected: {get: () => device.activated},
      close: {value: close}
    });

    return watch;
  }

  async function addConnection(_config) {
    const dbNmSettings = await _context.bus.getProxyObject(NS_NM, PATH_NM_SETTINGS);
    const dbNmSettingsIf = dbNmSettings.getInterface(NS_NM_SETTINGS);

    const connection = {
      'connection': {
        uuid: new dbus.Variant('s', _config.uuid),
        type: new dbus.Variant('s', '802-11-wireless'),
        id: new dbus.Variant('s', _config.id)
      },
      '802-11-wireless': {
        ssid: new dbus.Variant('ay', Buffer.from(_config.ssid))
      }
    };

    if (_config.security) {
      switch (_config.security.type) {
        case 'wpa-psk':
          connection['802-11-wireless-security'] = {
            'key-mgmt': new dbus.Variant('s', 'wpa-psk'),
            'psk': new dbus.Variant('s', _config.security.psk)
          };
      }
    }

    const dbConnection = await dbNmSettingsIf.AddConnection(connection);
    return dbConnection;
  }

  async function removeConnection(_uuid) {
    const dbNmSettings = await _context.bus.getProxyObject(NS_NM, PATH_NM_SETTINGS);
    const dbNmSettingsIf = dbNmSettings.getInterface(NS_NM_SETTINGS);
    const dbConnection = await dbNmSettingsIf.GetConnectionByUuid(_uuid);
    const dbSettingsConnection = await _context.bus.getProxyObject(NS_NM, dbConnection);
    const dbSettingsConnectionIf = dbSettingsConnection.getInterface(NS_NM_SETTINGS_CONNECTION);
    await dbSettingsConnectionIf.Delete();
  }

  async function activateConnection(_device, _connection) {
    const dbNm = await _context.bus.getProxyObject(NS_NM, PATH_NM);
    const dbNmIf = dbNm.getInterface(NS_NM);
    await dbNmIf.ActivateConnection(
      _connection,
      _device.path,
      '/'
    );
  }

  async function deactivateConnection(_device) {
    const dbConnectionActive = await _context.bus.getProxyObject(NS_NM, _device.activeConnection);
    const dbConnectionActiveProps = dbConnectionActive.getInterface(NS_PROPS);
    const dbConnection = await dbConnectionActiveProps.Get(NS_NM_CONNECTION_ACTIVE, 'Connection');

    const dbNm = await _context.bus.getProxyObject(NS_NM, PATH_NM);
    const dbNmIf = dbNm.getInterface(NS_NM);
    await dbNmIf.DeactivateConnection(_device.activeConnection);

    return dbConnection.value;
  }

  async function connect(_ssid, _security) {
    const dbConnection = await addConnection({
      uuid: UUID_PROV_CONNECTION,
      id: ID_PROV_CONNECTION,
      ssid: _ssid,
      security: _security
    });

    const device = await getWifiDevice();
    await activateConnection(device, dbConnection);
  }

  async function disconnect() {
    const device = await getWifiDevice();
    if (device.activeConnection !== '/') {
      const dbConnectionActive = await _context.bus.getProxyObject(NS_NM, device.activeConnection);
      const dbConnectionActiveProps = dbConnectionActive.getInterface(NS_PROPS);
      const dbUuid = await dbConnectionActiveProps.Get(NS_NM_CONNECTION_ACTIVE, 'Uuid');
      await deactivateConnection(device);
      if (dbUuid.value === UUID_PROV_CONNECTION) {
        await removeConnection(UUID_PROV_CONNECTION);
      }
    }

    // const connection = await deactivateConnection(device);
    // if (connection === '/') {
    //   return;
    // }

    // const dbSettingsConnection = await _context.bus.getProxyObject(NS_NM, connection);
    // const dbSettingsConnectionIf = dbSettingsConnection.getInterface(NS_NM_SETTINGS_CONNECTION);
    // const settings = await dbSettingsConnectionIf.GetSettings();
    // if (settings.connection.uuid.value === UUID_PROV_CONNECTION) {
    //   await removeConnection(settings.connection.uuid.value);
    // }
  }

  Object.defineProperties(proto, {
    isNetworkingEnabled: {value: isNetworkingEnabled},
    setNetworkingState: {value: setNetworkingState},
    isWirelessEnabled: {value: isWirelessEnabled},
    setWirelessState: {value: setWirelessState},
    getMac: {value: getMac},
    getConnectionStatus: {value: getConnectionStatus},
    watchConnectionStatus: {value: watchConnectionStatus},
    connect: {value: connect},
    disconnect: {value: disconnect}
  });

  return proto;
}

module.exports = factory;
