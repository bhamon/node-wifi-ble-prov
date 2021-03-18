# WiFi provisioning through BLE

This repository provides a simple WiFi provisioning service through BLE.

This service extensively uses DBus to interact with:
- The Network Manager for the WiFi part (org.freedesktop.NetworkManager).
- The Bluez stack for the BLE part (org.bluez).

An android application to interact with this BLE service can be found [here](https://github.com/bhamon/android-wifi-ble-prov).

## Prerequisites

The host system must provide a Network Manager as well as the Bluez stack.

### Raspberry Pi

The Bluez stack is installed by default with the Raspberry Pi OS (even on lite images).

However, WiFi connections are handled by a low-level WPA supplicant. To properly install the Network Manager, use the following commands:

```shell
apt install network-manager
apt purge openresolv dhcpcd5
```

## WPA supplicant

A sample WPA supplicant binding is provided for reference only.
The binding is fully functional but WiFi connections are not persistent accross reboots (breaking my use-case).
