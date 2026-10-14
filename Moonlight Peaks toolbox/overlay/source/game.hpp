// Access to the running Moonlight Peaks process through Atmosphère's
// dmnt:cht service (the same service cheat codes use).
//
// All offsets are for version 1.1.30 (main build ID BBA199B4CD2A58D2) and
// come from docs/memory-map.md. The overlay refuses to touch any other build,
// and checks the class of every object before writing to it.
#pragma once

#include <switch.h>
#include <cstddef>
#include <string>
#include <utility>
#include <vector>

namespace mp {

constexpr u64 kTitleId = 0x01008C8025C8E000ULL;
constexpr u8 kBuildId[8] = {0xBB, 0xA1, 0x99, 0xB4, 0xCD, 0x2A, 0x58, 0xD2};

// IL2CPP runtime layout (Unity 6000.3, metadata v39; Il2CppClass from il2cpp.h).
constexpr u64 kClassName = 0x10;          // Il2CppClass.name (const char*)
constexpr u64 kClassSelf = 0x78;          // Il2CppClass.klass (points to itself)
constexpr u64 kClassStaticFields = 0xB8;  // Il2CppClass.static_fields

// <Class>_TypeInfo globals (offsets from the main module base) for the two
// classes reached through static fields. Objects found from there are
// checked by class name instead: the game never initialises the TypeInfo
// globals of classes it only creates while loading the save.
namespace type {
constexpr u64 kSROptionsVampire = 0xF473028;
constexpr u64 kGamePersistence = 0xF46D3A8;
constexpr u64 kMonoBehaviourSingleton = 0xF470D28;  // static Dictionary<Type, MonoBehaviourSingleton> instances
}  // namespace type

// Fields of SROptionsVampire (the developers' debug options). Each one is read
// by the retail game code noted next to it (see docs/memory-map.md).
// Switches that can affect story or progression are deliberately left out.
namespace sro {
constexpr u32 kDisableEnergyUse = 0x10;           // PlayerPersistence.SubstractEnergy
constexpr u32 kDisableManaUse = 0x11;             // PlayerPersistence.SubstractMana
constexpr u32 kDailyRandomItemDropCheat = 0x36;   // EntityDailyRandomItemDrop.Interact
constexpr u32 kIgnoreToolTiers = 0x3A;            // BaseToolItemAddon.IsToolTierHighEnough
constexpr u32 kAlwaysSpawnProduce = 0x48;         // HousedCreatureSpawner.TrySpawningProduce
}  // namespace sro

// Field offsets (object header included).
namespace off {
constexpr u32 kGamePlayer = 0x68;               // GamePersistence.Player
constexpr u32 kGameTime = 0x80;                 // GamePersistence.Time
constexpr u32 kGameRooms = 0xB8;                // GamePersistence.Rooms
constexpr u32 kGameHousedCreatures = 0xE8;      // GamePersistence.HousedCreatures
constexpr u32 kRoomInventories = 0x148;         // RoomPersistence.Inventories (chests)
constexpr u32 kGameConstructions = 0x190;       // GamePersistence.GridObjectConstructions
constexpr u32 kConstructionDaysLeft = 0x28;     // GridObjectConstructionPersistence.DaysLeft (int)
constexpr u32 kDayProgresserSpeed = 0x48;       // DayProgresser.progressSpeedMultiplier (float)
constexpr u32 kObjectDictEntrySize = 0x18;      // Dictionary<ref,ref> entry: hashCode, next, key +0x8, value +0x10
constexpr u32 kObjectDictEntryValue = 0x10;
constexpr u32 kSlotQuality = 0x10;              // InventorySlotPersistence.ItemEntry.ItemQualityLevel
constexpr u32 kSlotMetadata = 0x18;             // InventorySlotPersistence.ItemEntry.Metadata
constexpr u32 kSlotCustomName = 0x20;           // InventorySlotPersistence.ItemEntry.CustomName
constexpr u32 kCreatureProduce = 0x70;          // CreaturePersistence.produceProgresses
constexpr u32 kSerializableDictDict = 0x20;     // SerializableDictionary<T,U>.dictionary
constexpr u32 kDictEntries = 0x18;              // Dictionary<K,V>._entries
constexpr u32 kDictCount = 0x20;                // Dictionary<K,V>._count
constexpr u32 kProduceEntrySize = 0x20;         // Entry<SerializedGuid,float>: hashCode, next, key, value
constexpr u32 kProduceEntryNext = 0x4;
constexpr u32 kProduceEntryValue = 0x18;
constexpr u32 kPlayerInventories = 0x10;        // PlayerPersistence.Inventories
constexpr u32 kTimeDayProgression = 0x10;       // TimePersistence.DayProgression (float)
constexpr u32 kRoomResourceConverters = 0xA0;   // RoomPersistence.ResourceConverters
constexpr u32 kConverterProducingItems = 0x20;  // ResourceConverterPersistence.ProducingItems
constexpr u32 kConverterPreviousDay = 0x28;     // ResourceConverterPersistence.PreviousDay (int)
constexpr u32 kGuid = 0x10;                     // GuidPersistence.Guid
constexpr u32 kInventorySlots = 0x20;           // InventoryPersistence.Slots
constexpr u32 kSlotAmount = 0x14;               // InventorySlotPersistence.ItemEntry.Amount
constexpr u32 kSlotItemRef = 0x28;              // InventorySlotPersistence.ItemEntry.itemRef
constexpr u32 kAssetRefGuid = 0x10;             // AssetRef.SerializedGuid
constexpr u32 kAssetRefRawAsset = 0x20;         // AssetRef.RawAsset (cached asset)
constexpr u32 kAssetGuid = 0x18;                // ScriptableObjectAsset.SerializedGuid
constexpr u32 kItemToolAddon = 0x110;           // ItemAsset.ToolAddon
constexpr u32 kToolDamage = 0x44;               // BaseToolItemAddon.Damage (int)
constexpr u32 kGuidListList = 0x10;             // GuidPersistenceList<T>.list
constexpr u32 kListItems = 0x10;                // List<T>._items
constexpr u32 kListSize = 0x18;                 // List<T>._size
constexpr u32 kArrayData = 0x20;                // first element of a managed array
}  // namespace off

// SerializedGuid as stored in memory (.NET Guid byte order).
struct Guid {
    u64 part1;
    u64 part2;
    bool operator==(const Guid&) const = default;
};

constexpr Guid kWalletInventory{0x4D687A298283381FULL, 0x27AF52A23073AFB7ULL};
constexpr Guid kToolsInventory{0x45B346CE5A81CDF9ULL, 0x1AAF5AAA30EA8CAEULL};
constexpr Guid kCoinItem{0x4C26A85262EC20C1ULL, 0x85F3FFE1173BC98AULL};
constexpr Guid kBackpackInventory{0x49637A4D03B692FBULL, 0xCA64AFE110C5EAAEULL};
constexpr Guid kStorageInventory{0x41E562A62D467B00ULL, 0xE5572B063ED699A0ULL};

// Night clock: DayProgression 0 = 18:00, 1 = 06:00 (GlobalSettingsLibrary
// DayStartHour 18, DayEndHour 6; formula from DayProgresser.GetTime).
constexpr int kDayStartHour = 18;
constexpr int kDayCycleHours = 12;
inline float progressionForHour(int hour) {
    return float((hour - kDayStartHour + 24) % 24) / float(kDayCycleHours);
}

constexpr s32 kOneHitDamage = 999;
constexpr s32 kMaxCoins = 99999999;

// One inventory slot as read from the game.
struct Slot {
    u64 address = 0;
    Guid item{};
    s32 amount = 0;
    bool empty = true;
};

// An existing AssetRef<ItemAsset> object in game memory, reusable to give
// that item (the game shares these too, e.g. when a stack is split).
struct ItemRef {
    Guid item;
    u64 assetRef;
};

enum class Status {
    NoCheatService,  // Atmosphère's dmnt:cht is not running
    NoGame,          // no game running
    OtherGame,       // a different game is running
    WrongVersion,    // Moonlight Peaks, but not version 1.1.30
    NotLoaded,       // right game, but no save is loaded yet
    Ready,
};

class Game {
public:
    // Attach to the running game and check it is a supported build.
    void attach();
    void detach();

    Status status() const { return status_; }
    const char* statusText() const;

    // Developer switches (SROptionsVampire.Current fields).
    bool getDevFlag(u32 offset, bool& out);
    bool setDevFlag(u32 offset, bool value);

    bool getCoins(s32& out);
    bool setCoins(s32 value);

    bool getDayProgression(float& out);
    bool setDayProgression(float value);

    // Moves every busy machine's last-update day back, so the game's own
    // production update treats that much time as elapsed. Returns the number
    // of machines changed, or -1 if the game data could not be read.
    int finishMachines(s32 days);

    // Axes and pickaxes in the tool belt: damage 999, or back to defaults.
    // Returns the number of tools in the requested state, or -1 on error.
    int setOneHit(bool on);
    bool getOneHit(bool& on);

    // Sets every housed animal's produce progress to full, so it can be
    // milked/sheared again or drops produce when the farm loads.
    // Returns the number of produce values changed, or -1 on error.
    int refillAnimalProduce();

    // Day clock speed (DayProgresser.progressSpeedMultiplier): 0 = paused, 1 = normal.
    bool getTimeSpeed(float& out);
    bool setTimeSpeed(float value);

    // Sets every construction with more than one day left to one day left,
    // so the game finishes it (and fires its own events) on the next night.
    // Returns the number of constructions that will finish tonight, or -1.
    int finishConstructionsTonight();

    bool readInventory(const Guid& inventory, std::vector<Slot>& out);
    // Sets a slot's amount after checking it still holds the same item.
    bool setSlotAmount(const Slot& slot, s32 amount);
    // Item references found in the player's inventories and chests, one per item.
    bool collectItemRefs(std::vector<ItemRef>& out);
    // Puts `amount` of the item into the inventory's first empty slot.
    // Returns the slot index, -1 if the game data could not be read, -2 if
    // there is no empty slot.
    int giveItem(const Guid& inventory, const ItemRef& ref, s32 amount);

    // One line per step of each memory path, for the Diagnostics page.
    std::vector<std::string> diagnose();

private:
    bool read(u64 addr, void* out, size_t size);
    bool write(u64 addr, const void* in, size_t size);
    template <typename T> bool read(u64 addr, T& out) { return read(addr, &out, sizeof(T)); }
    template <typename T> bool write(u64 addr, const T& value) { return write(addr, &value, sizeof(T)); }

    std::string className(u64 object);
    bool isInstance(u64 object, const char* name) { return className(object) == name; }
    u64 staticObject(u64 typeInfo, u64 staticFieldOffset, const char* name);
    u64 field(u64 object, u32 offset, const char* name);
    bool listItems(u64 list, std::vector<u64>& out);
    bool guidListItems(u64 guidList, std::vector<u64>& out);

    u64 persistence();
    u64 playerInventory(const Guid& id);
    u64 coinSlot();
    bool readSlot(u64 address, Slot& out);
    bool itemOfRef(u64 assetRef, Guid& out);
    u64 timePersistence();
    u64 singleton(const char* name);

    Status status_ = Status::NoGame;
    u64 mainBase_ = 0;
    bool serviceOpen_ = false;
    std::vector<std::pair<u64, std::string>> classNames_;  // verified Il2CppClass* -> name
};

}  // namespace mp
