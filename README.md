# Moonlight Peaks Save Editor & Toolbox

Two unofficial tools for **Moonlight Peaks** on Nintendo Switch:

- **Save editor** (this folder): edit a save backup in your web browser.
  Coins, item amounts, give any item, and more. Nothing to install.
- **[Toolbox](Moonlight%20Peaks%20toolbox/README.md)**: an in-game overlay
  menu for a modded Switch (Ultrahand/Tesla). Infinite energy, time
  controls, one-hit tools, machines, animals and more, while you play.

> **⚠️ Always back up your save before using these tools.**
> Keep a copy of your original save until you have checked your game. These
> are unofficial fan tools. **I am not responsible for any lost progress or
> save data corruption.**

## Save editor

### Requirements

- A way to copy your save off the Switch and back: a **modded Switch with
  JKSV** (or another save manager).
- A **computer with a recent web browser** (Firefox, Chrome, Edge…). It
  works offline, and your save never leaves your computer.
- A Moonlight Peaks save. The editor was made and tested with saves from
  **version 1.1.30**, and its item names come from that version.
- PC saves use the same format, so the PC `GameData` and `GameMetaData`
  files should open too. This hasn't been tested with a real PC save.

### How to use

1. On the Switch, open **JKSV**, choose Moonlight Peaks and make a backup.
   It goes to `sdmc:/JKSV/Moonlight Peaks/`.
2. Copy that backup (a `.zip`) to your computer.
3. Open **`index.html`** in your browser (double-click it; no server
   needed).
4. Drop the zip onto the page, or click **Choose file(s)…**. You can also
   open the loose `GameData` and `GameMetaData` files from `Saves/<slot>/`.
5. Make your changes, then click **Download edited save**. You get
   `<backup name>_edited.zip`.
6. Copy that file into the same JKSV folder on the SD card. **Eject the SD
   card properly** before removing it: on Linux especially, files can look
   copied but are only really written when you eject.
7. With the game **closed**, open JKSV, select the `_edited` backup and
   **restore** it. Start the game and check your save.

Keep your original backup. If anything looks wrong, restore it the same
way.

### What you can edit

| Tab | What you can do |
|---|---|
| Overview | Coins (also updates the coin count on the load screen) |
| Inventories & chests | Backpack, storage, tools and placed chests: change amounts and quality, remove items, and add **any item** from the game's catalogue into a free slot. Amounts are capped at each item's real max stack. |
| Item list | Every item with its English name, category and max stack, where you have it, and your own custom names |
| Advanced | Every value in the save, with field types enforced |

Recipes, cards, spells, forms and customizations are read-only until you
click "Allow editing".

### Warnings and known issues

- **Back up first.** I am not responsible for lost progress or corrupted
  saves.
- **Add everyday items only:** resources, seeds, food, decorations, farm
  helpers. Adding cards, spells, forms, customizations or quest items can
  unlock content or break your story progress.
- **Energy, mana and time of day can't be edited here.** They aren't stored
  in the save: the game saves when you sleep and refills your energy when
  you wake up. Use the in-game [Toolbox](Moonlight%20Peaks%20toolbox/README.md)
  for those.
- The Toolbox has its own known issues (time travel, constructions). See
  [its README](Moonlight%20Peaks%20toolbox/README.md#known-issues).

## How the save works

- `Saves/<slot>/GameData` is the world state. `GameMetaData` is the summary
  shown on the load screen, and `GlobalData` holds the settings.
- Each file is UTF-8 JSON written by Newtonsoft Json.NET and
  gzip-compressed on Switch. There is no encryption and no checksum.
- Items are referenced by GUID. Coins are the item `62ec20c1-…` in a
  one-slot "wallet" inventory.
- The editor keeps every byte you didn't change. Unchanged files are copied
  as they are, and numbers keep Json.NET's formatting.

## Updating the item database

`data/items.js` (item names, categories, max stacks) and `data/game.js`
(inventory and room names) are generated from the game. The current files
come from version 1.1.30. After a game update, regenerate them from your own
backups of the game:

```sh
pip install UnityPy          # needs Python 3.14+ (built-in zstd)
python3 tools/extract_game_data.py "<base game>.nsz" "<update>.nsz"
```

No console keys or RomFS dump are needed: the script reads the
block-compressed NSZ files directly and applies the update itself. Then
regenerate the Toolbox's copy with
`python3 "Moonlight Peaks toolbox/tools/gen_items_db.py"`.

## Development

```sh
node tools/test.js <JKSV backup.zip> <output dir>
python3 tools/verify_export.py <backup.zip> <output dir>/edited.zip <output dir>/expected.json
```

`test.js` checks the lossless round trip, an unedited export staying
byte-identical, the edit operations and shared item references.
`verify_export.py` re-reads the result with Python's own zip, gzip and json
modules and lists every changed value.

| Path | Content |
|---|---|
| `index.html`, `js/`, `data/` | The save editor |
| `tools/` | Tests, game-data extraction, NSZ/RomFS readers (`tools/nx`) |
| `Moonlight Peaks toolbox/` | The in-game overlay |

## License

- The save editor and its tools (everything outside `Moonlight Peaks toolbox/`)
  are under the [MIT License](LICENSE).
- The in-game Toolbox (`Moonlight Peaks toolbox/`) is under the
  [GNU GPL v2.0](Moonlight%20Peaks%20toolbox/LICENSE), because it includes
  GPL-2.0 code (libultrahand and Atmosphère's `dmnt:cht` client).

This is a fan project. It is not affiliated with the developers or
publishers of Moonlight Peaks.
