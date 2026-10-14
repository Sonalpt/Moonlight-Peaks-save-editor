# Moonlight Peaks Toolbox (in-game overlay)

An in-game menu for **Moonlight Peaks** on a modded Nintendo Switch. It opens
on top of the game from Ultrahand (or Tesla) and changes the game while you
play: energy, mana, coins, time, items, machines, animals and buildings.

> **⚠️ Back up your save before using this tool.**
> Make a backup with JKSV (or another save manager) before every session,
> and keep it until you have checked your game. This is an unofficial fan
> tool that changes the game's memory while it runs. **I am not responsible
> for any lost progress or save data corruption.**

## Requirements

- A **Nintendo Switch running Atmosphère** custom firmware. The toolbox uses
  Atmosphère's cheat service (`dmnt:cht`), which is enabled by default.
- **Ultrahand Overlay** (or Tesla Menu) with nx-ovlloader installed.
- **Moonlight Peaks version 1.1.30** (game update v131072, build ID
  `BBA199B4CD2A58D2`). The toolbox checks the version when it starts and
  does nothing on any other version.
- **JKSV** or another save manager, for backups.

## Install

1. Get `MoonlightPeaksToolbox.ovl` from the Releases page, or build it (see
   below).
2. Copy it to `/switch/.overlays/` on your SD card.
3. Eject the SD card properly before removing it, then put it back in the
   Switch and boot Atmosphère.

## Use

1. Start Moonlight Peaks and **load your save**.
2. Open Ultrahand (by default **L + D-pad Down + right stick click**) and
   choose **Moonlight Peaks Toolbox**.
3. The first line should say **"Moonlight Peaks 1.1.30 detected"**. If it
   says something else (for example "Load your save first"), do that and
   reopen the menu.

| Section | Option | What it does |
|---|---|---|
| Player | Infinite energy / Infinite mana | Working and casting spells no longer cost energy or mana |
| Inventory | Backpack / Storage | Lists every slot with its item name and amount. Press A on a stack to change the amount (capped at the item's max stack). |
| Inventory | Give items | Adds resources, seeds, food, decorations, farm helpers or fertilizer to the first free slot of your backpack or storage |
| Coins | Add 1,000 / 10,000 / 100,000 | Adds coins (up to 99,999,999) |
| Time | Jump forward to… | Moves the clock to a later hour tonight |
| Time | Pause time / Time speed | Stops the clock, or runs it at ×½, ×1 or ×2 |
| Buildings | Finish constructions tonight | Constructions in progress get one day left. Sleep and they are finished the next morning. |
| Farm & gathering | One-hit trees & rocks | Your axes and pickaxes break things in one hit |
| Farm & gathering | Any tool breaks anything | Any tool tier can break any ore, rock or stump |
| Farm & gathering | Animals always drop produce | Animals drop their produce every time the farm loads |
| Farm & gathering | Refill animal produce | Animals can be milked, sheared or collected again right away |
| Farm & gathering | Finish all machines | Kegs, presses, furnaces… finish what they are making |
| Farm & gathering | Repeatable daily item drops | Daily item spots can be collected again |
| Help | Diagnostics | Shows what the toolbox can find in the game, to report problems |

### What stays after you save

- **Kept** when the game saves (when you sleep): coins, items and amounts,
  time of day, finished machines, animal produce and constructions.
- **Reset** when the game restarts: the switches (infinite energy, one-hit
  and so on), pause and time speed.

## Known issues

1. **Time travel can break NPC routes and shops.** If you jump forward in
   time during a day (for example from 7 PM to 11 PM), NPCs may not follow
   their usual routes, and a shop can stay closed even during its opening
   hours. Shops can still work after a time jump, but it isn't guaranteed.
   Use time travel on days when you only want to farm or try the mod, not
   when you need the shops. It only affects the day you are playing: sleep
   and everything is back to normal.
2. **Unpause the clock when you time travel.** If "Pause time" is on, the
   time jump doesn't work. Switch "Pause time" off before using
   "Jump forward to…".
3. **Constructions work for farm buildings, but not for home expansions.**
   "Finish constructions tonight" works for buildings on your farm (barn,
   coop, windmill…), but not for upgrades and expansions of your house.

Other limitations:

- **Give items** only offers items the game already has loaded: what is in
  your inventories, chests and known recipes. Items you have never seen
  can't be given.
- After adding coins, the coin counter on screen may only update at your
  next purchase or sale.
- There is no "shops always open" or "hide HUD" option. Both need code
  changes that an overlay can't make safely.

## Optional: cheat codes

`sd/atmosphere/contents/01008C8025C8E000/cheats/BBA199B4CD2A58D2.txt`
contains Atmosphère cheat codes for infinite energy and mana. To use them,
copy the `sd/atmosphere` folder to the root of your SD card and switch them
on in the EdiZon overlay. While they are on, the toolbox can't switch those
two options off.

## Build from source

You need [devkitPro](https://devkitpro.org) (devkitA64 and libnx), or use
its container. Run this inside the `overlay` folder:

```sh
podman run --rm --security-opt label=disable -v "$PWD":/project -w /project \
  docker.io/devkitpro/devkita64:latest \
  bash -c 'export PATH=$DEVKITPRO/devkitA64/bin:$DEVKITPRO/tools/bin:$PATH; make'
```

The overlay is written to `overlay/out/switch/.overlays/MoonlightPeaksToolbox.ovl`.

The item names come from `overlay/source/items_db.inc`. That file is
generated from the save editor's database: run
`python3 tools/gen_items_db.py` after updating `../data/items.js`.

How the toolbox finds things in the game's memory is documented in
[docs/memory-map.md](docs/memory-map.md). The version history is in
[CHANGELOG.md](CHANGELOG.md).

## License

[GNU GPL v2.0](LICENSE). The toolbox uses
[libultrahand](https://github.com/ppkantorski/libultrahand) (GPL-2.0) and
Atmosphère's `dmnt:cht` client (GPL-2.0). The save editor in the parent
folder is under the MIT License.

This is a fan project. It is not affiliated with the developers or
publishers of Moonlight Peaks.
