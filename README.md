# Onkyo AVR Manager for Volumio

Volumio system controller plugin for managing an Onkyo AVR over Ethernet eISCP.

The plugin can discover an Onkyo receiver on the local network, power it on when playback starts, select a configured input, unmute it, and route Volumio volume commands to the receiver instead of relying on Volumio's software volume.

## Features

- Connects to Onkyo AVRs over TCP eISCP, default port `60128`.
- Optional UDP discovery using Onkyo `ECNQSTN`.
- Playback-start automation:
  - power on receiver
  - select configured HDMI/input source
  - unmute receiver
  - optionally set a default receiver volume
- Optional receiver power-off when Volumio is actually powered down.
- Volumio volume slider integration:
  - slider changes send Onkyo `MVL` volume commands
  - mute/unmute sends Onkyo `AMT` commands
  - AVR volume feedback updates Volumio's visible slider
- Reconnect logic for receiver/network interruptions.
- Configuration UI inside Volumio.

## Requirements

- Volumio with plugin support.
- An Onkyo-compatible AVR with network/eISCP control enabled.
- The Volumio device and AVR must be reachable on the same network.
- Node.js `>=8`, matching Volumio's plugin runtime.

## Installation

From a Volumio shell, install the plugin using Volumio's local plugin tooling, or copy the plugin directory to:

```text
/data/plugins/system_controller/onkyo_avr_manager
```

Then restart Volumio:

```bash
volumio vrestart
```

This repository also keeps build artifacts under `_build_artifacts/` when packaging locally, but those archives are intentionally ignored by Git.

## Configuration

Open the plugin settings in Volumio:

```text
Plugins -> System Controller -> Onkyo AVR Manager
```

Available settings:

| Setting | Default | Description |
| --- | ---: | --- |
| Receiver IP address or hostname | `192.168.1.100` | Receiver address used when discovery is disabled or as fallback. |
| eISCP TCP port | `60128` | Onkyo network control port. |
| Automatically discover receiver | `true` | Uses UDP broadcast discovery and saves the discovered IP. |
| Discovery broadcast address | `255.255.255.255` | Broadcast address used for receiver discovery. |
| Discovery timeout in milliseconds | `3000` | Time to wait for a discovery response. |
| Configured HDMI input SLI code | `11` | Onkyo `SLI` input code selected on playback start. |
| Run automation on playback start | `true` | Master switch for playback-start actions. |
| Power on receiver on playback start | `true` | Sends `PWR01`. |
| Select configured HDMI input on playback start | `true` | Sends `SLIxx` using the configured input code. |
| Unmute receiver on playback start | `true` | Sends `AMT00`. |
| Set default volume on playback start | `false` | Optionally sets receiver volume when playback starts. |
| Power off receiver when Volumio shuts down | `true` | Sends `PWR00` only during OS poweroff/halt, not playback stop/pause or reboot. |
| Use Volumio volume slider for receiver | `true` | Registers plugin as Volumio volume override. |
| Receiver maximum volume | `80` | Maps Volumio `0..100` to AVR `0..receiverMaxVolume`. |
| Volume slider debounce in milliseconds | `200` | Debounce used by fallback state listener. |
| Delay after power on in milliseconds | `1500` | Wait before selecting input/unmuting after power-on. |
| Default volume level | `35` | Receiver volume used when default-volume automation is enabled. |
| Reconnect delay in milliseconds | `5000` | Delay before reconnect attempts. |

## Volume Control Behavior

When `Use Volumio volume slider for receiver` is enabled, the plugin registers as a Volumio volume override with:

```js
volumeOverride: true
pluginType: 'system_controller'
pluginName: 'onkyo_avr_manager'
```

Volumio then calls the plugin's `alsavolume()` method for slider and mute commands.

### Volumio Slider to AVR

Volumio slider values are mapped from `0..100` to the configured receiver range:

```text
receiverVolume = round((volumioVolume / 100) * receiverMaxVolume)
```

Example with `receiverMaxVolume = 80`:

```text
Volumio 50 -> AVR 40
Volumio 75 -> AVR 60
Volumio 100 -> AVR 80
```

The plugin sends:

```text
MVLxx
```

where `xx` is the AVR volume as a two-digit hexadecimal value.

### AVR to Volumio Slider

When the AVR volume changes from its remote, front panel, or another controller, the receiver sends volume feedback. The plugin parses that feedback and maps it back to Volumio's `0..100` range:

```text
volumioVolume = round((receiverVolume / receiverMaxVolume) * 100)
```

Then it pushes the state to Volumio so the slider follows the receiver.

### Mute

Volumio mute commands map to Onkyo mute commands:

```text
mute   -> AMT01
unmute -> AMT00
```

AVR mute feedback is parsed from `AMT` messages and pushed back to Volumio.

## Recommended Volumio Volume Setup

The desired audio path is:

```text
Volumio digital output at full scale -> AVR controls listening volume
```

In practice, Volumio still needs the volume UI to remain enabled. The plugin registers a valid software-mixer-shaped override so the slider stays visible, but volume commands are intercepted by the plugin and routed to the AVR.

Recommended checks:

1. Confirm the plugin is registered:

   ```bash
   journalctl -u volumio -n 300 --no-pager | grep onkyo_avr_manager
   ```

   Look for:

   ```text
   Registered Onkyo AVR as Volumio volume override
   ```

2. Confirm the digital mixer is not attenuated:

   ```bash
   amixer -M get -c 1 SoftMaster
   ```

   On the tested setup, a full-scale digital path showed:

   ```text
   Front Left: 99 [100%]
   Front Right: 99 [100%]
   ```

Your ALSA card number or mixer name may differ from `-c 1 SoftMaster`; check Volumio's audio settings if the command does not apply to your device.

## Logs

Follow Volumio logs:

```bash
journalctl -u volumio -f
```

Filter this plugin:

```bash
journalctl -u volumio -f | grep onkyo_avr_manager
```

Useful startup checks:

```text
[onkyo_avr_manager] Registered Onkyo AVR as Volumio volume override
[onkyo_avr_manager] Connected to Onkyo AVR at <ip>:60128
[onkyo_avr_manager] RX parsed power: 01
[onkyo_avr_manager] RX parsed volume: ...
```

Volume-slider checks:

```text
CoreCommandRouter::executeOnPlugin: onkyo_avr_manager , alsavolume
[onkyo_avr_manager] Volumio volume override set to 50; setting AVR volume to 40
[onkyo_avr_manager] TX !1MVL28
```

If you see `VolumeController::SetAlsaVolume...` during normal slider changes, Volumio is still touching the digital/software mixer. Re-check the plugin registration log and the current Volumio audio mixer configuration.

## Shutdown Behavior

When `Power off receiver when Volumio shuts down` is enabled, the plugin attempts to send:

```text
PWR00
```

only when Volumio is being powered off or halted at the operating-system level.

It is intentionally not triggered by:

- playback stop
- playback pause
- plugin disable/restart
- Volumio service restart
- Volumio reboot

The plugin distinguishes shutdown from reboot by checking systemd jobs during plugin stop. It powers off the AVR only when `poweroff.target` or `halt.target` is active, and skips the action when `reboot.target` is active.

The plugin also installs a small systemd helper:

```text
/etc/systemd/system/onkyo-avr-poweroff.service
```

That helper is started at boot and remains active. During system shutdown, systemd runs its `ExecStop` command before `shutdown.target`. The helper script checks systemd's active jobs and sends `PWR00` only when `poweroff.target` or `halt.target` is present. It skips reboot and ordinary service restarts.

This is more reliable than depending only on Volumio's plugin stop lifecycle because system shutdown ordering can stop Volumio before plugin cleanup has enough time to run.

## Troubleshooting

### Slider is missing

Volumio may hide the slider when its mixer type is set to `None`. The plugin is designed to keep `disableVolumeControl: false` when registered as the volume override. Restart Volumio after enabling the plugin:

```bash
volumio vrestart
```

Then check:

```bash
volumio status | grep -E 'volume|mute|disableVolumeControl'
```

Expected:

```text
"disableVolumeControl": false
```

### Digital volume changes as well as AVR volume

Check for ALSA writes:

```bash
journalctl -u volumio --since '10 minutes ago' --no-pager | grep SetAlsaVolume
```

If they appear during slider moves, confirm the override is registered:

```bash
journalctl -u volumio --since '10 minutes ago' --no-pager | grep 'Registered Onkyo AVR'
```

Also check the actual software mixer level and set it back to full scale if needed.

### Receiver is not found

Check that:

- the AVR is on the same network as Volumio
- network control is enabled on the AVR
- UDP broadcast is allowed on the network
- TCP port `60128` is reachable

If discovery fails, disable automatic discovery and set the receiver IP manually.

### AVR is off

Some Onkyo receivers still answer eISCP queries while in standby, while others do not. Playback automation can send `PWR01` when Volumio starts playback.

## Development

Install dependencies:

```bash
npm install
```

Syntax-check the plugin:

```bash
node --check index.js
```

Package locally:

```bash
volumio plugin package
```

The plugin entry point is:

```text
index.js
```

Volumio configuration files:

```text
config.json
UIConfig.json
i18n/strings_en.json
```

## Notes

- Onkyo input codes are receiver-specific. Common HDMI input codes vary by model; verify the correct `SLI` code for your AVR.
- `receiverMaxVolume` is a safety and scaling setting. Set it to the highest AVR volume you want Volumio's `100` to represent.
- The plugin intentionally keeps AVR and Volumio slider state synchronized using receiver feedback when available.

## License

MIT
