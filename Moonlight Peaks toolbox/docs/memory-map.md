# Moonlight Peaks 1.1.30 (Switch) memory map

Game: title `01008C8025C8E000`, version 1.1.30, main build ID
`BBA199B4CD2A58D2`. Unity 6000.3.6f1, IL2CPP metadata v39.

Addresses are offsets from the base of the `main` module. They are only
valid for this build ID.

## How it was obtained

1. `main` and `global-metadata.dat` were extracted from the user's NSZ
   backups with the readers in `tools/nx` at the repository root.
2. The Il2CppDumper fork `Doppelglower/Il2CppDumper` (v39 support) was
   built in a .NET 8 container, with one fix in `NSO.cs`: this SDK puts the
   `MOD0` header in `.rodata`, and its fields are relative to `MOD0`.
   It gives CodeRegistration `0xECB6060` and MetadataRegistration `0xF0CB290`.
3. The functions were read with small Capstone scripts (`disasm.py`,
   `xrefs.py`, `datarefs.py`, `flagmap.py`). They are kept out of this
   repository because they work on the game's own executable.

## IL2CPP runtime layout

- `<Class>_TypeInfo` globals hold an `Il2CppClass*` once the class is
  initialised.
- `Il2CppClass + 0xB8` is the `static_fields` pointer.
  `Il2CppClass + 0xE4` is non-zero once the static constructor has run.
- Field offsets in `dump.cs` include the 0x10-byte object header.

## Developer options: `SROptionsVampire`

`SROptionsVampire_TypeInfo` is at `main + 0xF473028`. The static field
`Current` is at `static_fields + 0x0`.

Chain: `[[[main+0xF473028] + 0xB8] + 0x0] + field`

| Offset | Field | Read by game code (found with `flagmap.py`) | In overlay |
|---|---|---|---|
| 0x10 | disableEnergyUse | `PlayerPersistence.SubstractEnergy` skips the subtraction (**confirmed on console**) | yes |
| 0x11 | disableManaUse | `PlayerPersistence.SubstractMana` skips the subtraction (**confirmed on console**) | yes |
| 0x20 | disableNpcSpawning | `NpcWalker.InstantiateNpc`, `GameSwitchRoomState` | no |
| 0x22 | useDebugDataInDailyUpdate | `DailyUpdate*State.Setup` | no |
| 0x23 | showAllCustomization | `CustomizationLibrary.GetCharacterCreatorCustomizations` | no |
| 0x28 | isTimeStopped | only `DayProgresser.Awake` (so it applies on room load) and `QuestScreen` | no |
| 0x31 | timeCheat | `TimeCheater.get_isAllowed` (needs a developer input binding) | no |
| 0x32 | fasterTimeScale | `TimeCheater.Update` | no |
| 0x33 | creativeMode | decorate and placement checks (`BaseDecorateState`, `ContextPopupScreenExtensions`) | no (placement could break layouts) |
| 0x34 | itemRequirementsCheat | every item check: quests (`CheckInventory`), jobs, crafting | **no** (would break quest logic) |
| 0x35 | witchCirclesUnlockedCheat | `WitchCirclePersistence.get_IsActivated`, `WitchCircleInteractable` | no (progression) |
| 0x36 | dailyRandomItemDropCheat | `EntityDailyRandomItemDrop.Interact`, `DailyRandomItemDropPersistence` | yes |
| 0x37 | autoWinNokturna | `CardGame.TryCheckAutoWinCheat` | no (progression) |
| 0x38 | disableGrowingSpawningSpreading | crops, weeds and crows `ProcessDay` (it would also stop crops) | no |
| 0x3A | ignoreToolTiers | `BaseToolItemAddon.IsToolTierHighEnough` | yes |
| 0x3D | disableRoutines | `RoutineTimeListenerNode.HandleTimeTick` | no |
| 0x3E | hideUI | only read in some screens' `OnShow`; `set_HideUI` also dispatches an `EventBus` `Signal<bool>` that does the actual hiding | no (needs that signal; removed in v0.3.2) |
| 0x48 | alwaysSpawnProduce | `HousedCreatureSpawner.TrySpawningProduce`: produce spawns regardless of `GetProduceProgress` | yes |

The developer action methods are compiled in: `ReplenishEnergy`,
`AddCoins`, `GiveMaxOfHighlightedItem`, `AddOneHour`, `SkipToNextSeason`,
the unlocks, and so on. The SRDebugger panel ships in the game, and
`SROptionsVampire.Setup` ends by calling `SRDebug.Init`.

## Player state

`GamePersistence_TypeInfo` is at `main + 0xF46D3A8`. `Instance` is at
`static_fields + 0x0`, and `PlayerPersistence` is at `Instance + 0x68`.

`PlayerPersistence` fields: `Inventories` 0x10, `GrabbedItemEntry` 0x18,
`Playtime` 0x60, `StatusEffects` 0x68, `MaxManaSources` 0x70,
`MaxEnergySources` 0x78.

`Energy` and `Mana` are properties with no backing field. The current value
lives in a `GlobalVariableAsset` reached through
`AddressablesLibrary.Get<VariableLibrary>()`:

- `VariableLibrary + 0xA8` is the energy variable.
- The value is read through `GlobalVariableAsset.TryGetPersistence`, then
  `persistence + 0x20`, then `+ 0x10` (a float).

`ReplenishEnergy` calls `AddEnergy(get_EnergyMax())`.

## Time: `DayProgresser` (a `MonoBehaviourSingleton`)

| Offset | Field |
|---|---|
| 0x20 | dayProgressScrubber (float) |
| 0x24 | autoScrub |
| 0x28 | scrubSpeed |
| 0x39 | IsFastForwardingTime |
| 0x48 | progressSpeedMultiplier (float) |
| 0x50 | dayProgressBlocker |
| 0x60 | dayDurationAsset |

TODO: find the singleton `Instance` static and how `Update` advances
`GamePersistence.Time.DayProgression`.

## Atmosphère cheat encoding used

```
580F0000 0F473028           R15 = [main + 0xF473028]   (Il2CppClass*)
580F1000 000000B8           R15 = [R15 + 0xB8]         (static_fields)
580F1000 00000000           R15 = [R15 + 0x0]          (Current)
780F0000 000000XX           R15 += field offset
610F0000 00000000 00000001  byte [R15] = 1
```

## Checking classes (lesson from v0.3.0)

`<Class>_TypeInfo` globals are only filled in once code that references them
runs. Objects created by the JSON loader (inventories, rooms, slots) can
exist while their TypeInfo is still 0, so comparing against it fails.

The overlay now checks the class name instead:

- `[object]` is the `Il2CppClass*`.
- `Il2CppClass + 0x78` (`klass`) must point back to itself.
- `Il2CppClass + 0x10` (`name`) must match. Generic classes are named like
  `Dictionary`2`.

## Animal produce

`GamePersistence + 0xE8` is `HousedCreatures`. Each `CreaturePersistence`
has `produceProgresses` at +0x70 (a `SerializableDictionary`). Its live
`.dictionary` is at +0x20, and `Dictionary._entries` at +0x18, with
`_count` at +0x20 and `_freeCount` at +0x28. Each entry is 0x20 bytes:
`hashCode`, `next`, `key` (SerializedGuid) at +0x8, and the float `value` at
+0x18.

`GetProduceProgress` (verified) reads that value. The milk menu
(`CreatureProduceMenuNode`) and `HousedCreatureSpawner` use it, and
`DirectorHarvestCreatureState` resets it to 0.

## v0.3 features

All of these start from `GamePersistence.Instance`, using the chain above.
The overlay checks the exact class of every object (none of these classes
has subclasses).

| Type | `_TypeInfo` (main +) |
|---|---|
| GamePersistence | 0xF46D3A8 |
| PlayerPersistence | 0xF471E28 |
| TimePersistence | 0xF474AD8 |
| RoomPersistence | 0xF472DC8 |
| InventoryPersistence | 0xF46F970 |
| InventorySlotPersistence | 0xF46F988 |
| ResourceConverterItemPersistence | 0xF472C30 |
| ItemAsset | 0xF46FA18 |

Containers: `GuidPersistenceList<T>` holds a `List<T>` at +0x10. `List<T>`
has `_items` at +0x10 and `_size` at +0x18. Array elements start at +0x20.

The runtime `Inventory` wraps the save's `InventoryPersistence`
(`Inventory.persistence` +0x30), so the persistence objects are the live
data.

- **Coins:** `Player (+0x68) → Inventories (+0x10)`, then the inventory
  whose `Guid` (+0x10) is the wallet `8283381f-…`, then
  `Slots (+0x20)[0]`. That slot's `ItemEntry` starts at +0x10: `Amount` at
  +0x14 and `itemRef` at +0x28 (`AssetRef.SerializedGuid` +0x10, the coin
  `62ec20c1-…`).
- **Time:** `Time (+0x80) → DayProgression (+0x10)`, a float from 0 to 1.
  `DayProgresser.ProgressTime` adds the frame delta to it and clamps it.
  `GetTime`: hour = 18 + p × 12 (`GlobalSettingsLibrary` DayStartHour 18,
  DayEndHour 6).
- **Machines:** `Rooms (+0xB8)`, then each room's `ResourceConverters`
  (+0xA0), then each converter's `ProducingItems` (+0x20), `PreviousDay`
  (+0x28) and `PreviousDayProgression` (+0x2C).
  `BaseResourceConverterView.UpdateProductionProgress` turns
  `GetTimeDifferenceFromPastToToday(PreviousDay, …)` into elapsed time for
  `ProcessItemsQueued` / `ProcessItemsParallel`.
- **One-hit:** both `DestructibleHitInteractable.ResolveInteraction` (via
  `DestructibleView.Hit`) and `ChopStumpGridComponent.Chop` use
  `GrabbedItemAsset/ToolAddon.Damage`. The chain is `ItemAsset + 0x110` →
  `ToolAddon`, then `Damage` at +0x44. The tool belt slot's `itemRef.RawAsset`
  (+0x20) is the cached `ItemAsset`.

## v0.4: inventories and giving items

`InventorySlotPersistence` has the `ItemEntry` struct at +0x10:
`ItemQualityLevel` (int) +0x0, `Amount` +0x4, `Metadata` (string) +0x8,
`CustomName` +0x10, `itemRef` (`AssetRef<ItemAsset>`) +0x18. In slot terms,
that is +0x10, +0x14, +0x18, +0x20 and +0x28. Empty slots have
`itemRef == null` and `Amount == 0`.

Backpack is `03b692fb-…` (GameInventory_Inventory). Storage is `2d467b00-…`
(GameInventory_GlobalInventory). Chests are at `RoomPersistence +0x148`
(`Inventories`).

To give an item into an empty slot, the overlay writes quality 0, then the
amount, then the pointer to an existing `AssetRef`1` object for that item,
taken from another slot (the class is checked by name, and its GUID must
match). Splitting a stack shares the reference the same way. Json.NET
(`PreserveReferencesHandling`, see the `$id` fields) writes the second use
as `{"$ref": id}` and resolves it on load.

## Shops (investigated, not implemented)

The shop directors (`fullgame_shop_*_director` bundles) are reached through
the shopkeeper's prompt (`ButtonListenerNode`, `PromptNode`, `ShopNode`).
There is no time check in the graph. Availability comes from the NPC
routine (`EntityShopkeepActivity`). Some routines also set
`$Routine_Is<Shop>Open` variables. `MapLocationMarker`'s
`ShopOpening/ClosingHour` variables are only for the map display.

## v0.5: singletons, time speed, constructions

`MonoBehaviourSingleton` (non-generic, `_TypeInfo` at main + 0xF470D28) has
a static `Dictionary<Type, MonoBehaviourSingleton> instances` at
`static_fields + 0`. In the shared `Dictionary<object,object>` layout, the
entries are 0x18 bytes each (verified via `FindEntry`:
`mov w25,#0x18; smaddl`): `next` +0x4, key +0x8, value +0x10. The overlay
finds a singleton by checking each value's class name (for example
`DayProgresser`).

- **Time speed:** `DayProgresser.Update` passes
  `Time.deltaTime / dayDuration.duration(+0x28) * progressSpeedMultiplier(+0x48)`
  to `ProgressTime` when nothing is blocking time. 0 pauses the clock.
- **Constructions:** `GamePersistence + 0x190` is `GridObjectConstructions`.
  Each `GridObjectConstructionPersistence` has `ItemAssetRef` +0x20 and
  `DaysLeft` (int) +0x28. `get_IsUnderConstruction` is `DaysLeft > 0`.
  `GridObjectConstructionView.Load` shows the scaffolding while
  `DaysLeft >= 1`. Each night, the director node
  `UpdateGridObjectConstructionPersistenceNode` decrements `DaysLeft` and
  dispatches the item's `EventAsset` when it reaches 0. The overlay
  therefore only sets `DaysLeft` to 1, never to 0.
