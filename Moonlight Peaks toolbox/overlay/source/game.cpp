#include "game.hpp"

#include <cstdarg>
#include <cstdio>
#include <cstring>

#include "dmntcht.h"

namespace mp {

namespace {

// Asking sm for a service that is not registered can block, so check first:
// registering the name only fails when dmnt already provides it.
bool cheatServiceRunning() {
    Handle handle;
    SmServiceName name = smEncodeName("dmnt:cht");
    if (R_SUCCEEDED(smRegisterService(&handle, name, false, 1))) {
        svcCloseHandle(handle);
        smUnregisterService(name);
        return false;
    }
    return true;
}

bool plausiblePointer(u64 p) {
    return p >= 0x1000000 && (p & 7) == 0;
}

// Default damage of every axe and pickaxe (ToolAddon.Damage in the 1.1.30
// assets), used to restore them when one-hit break is switched off.
struct ToolDamage {
    Guid item;
    s32 damage;
};
constexpr ToolDamage kAxesAndPickaxes[] = {
    {{0xF33EEFB5A5E13C1CULL, 0x8A12CC4628D4E279ULL}, 5},   // Rusty Axe
    {{0x0722C735110CEEEFULL, 0xACFEC9DCF8E68626ULL}, 5},   // Rusty Pickaxe
    {{0x47C18C3F95426409ULL, 0x29A8B510292FD29BULL}, 6},   // Copper Axe
    {{0x4DCB80D1009096EDULL, 0xD74667D8AB2D539CULL}, 6},   // Copper Pickaxe
    {{0x494CE381F40E8DFAULL, 0xFECA4DB474FDDFA2ULL}, 8},   // Iron Axe
    {{0x4929A4869DF12444ULL, 0xD319C4B15FA5AF90ULL}, 8},   // Iron Pickaxe
    {{0x480B283533EB3A96ULL, 0xC276711FED5BD9A8ULL}, 10},  // Gold Axe
    {{0x401C09AE4FC5560AULL, 0xE82A7C6E3D725494ULL}, 10},  // Gold Pickaxe
    {{0x4F231129800B5409ULL, 0x8FEE4C9FCA74D8B6ULL}, 15},  // Enchanted Axe
    {{0x48DDA74A3927896AULL, 0x6233405051E53CBDULL}, 15},  // Enchanted Pickaxe
};

const ToolDamage* findTool(const Guid& id) {
    for (const auto& t : kAxesAndPickaxes)
        if (t.item == id) return &t;
    return nullptr;
}

std::string format(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
std::string format(const char* fmt, ...) {
    char buf[96];
    va_list args;
    va_start(args, fmt);
    std::vsnprintf(buf, sizeof(buf), fmt, args);
    va_end(args);
    return buf;
}

}  // namespace

void Game::attach() {
    mainBase_ = 0;
    classNames_.clear();
    if (!cheatServiceRunning()) {
        status_ = Status::NoCheatService;
        return;
    }
    if (!serviceOpen_) {
        if (R_FAILED(dmntchtInitialize())) {
            status_ = Status::NoCheatService;
            return;
        }
        serviceOpen_ = true;
    }
    u64 pid = 0;
    if (R_FAILED(pmdmntGetApplicationProcessId(&pid)) || R_FAILED(dmntchtForceOpenCheatProcess())) {
        status_ = Status::NoGame;
        return;
    }
    DmntCheatProcessMetadata meta{};
    if (R_FAILED(dmntchtGetCheatProcessMetadata(&meta))) {
        status_ = Status::NoGame;
        return;
    }
    if (meta.title_id != kTitleId) {
        status_ = Status::OtherGame;
        return;
    }
    if (std::memcmp(meta.main_nso_build_id, kBuildId, sizeof(kBuildId)) != 0) {
        status_ = Status::WrongVersion;
        return;
    }
    mainBase_ = meta.main_nso_extents.base;
    status_ = Status::Ready;
    if (staticObject(type::kSROptionsVampire, 0, "SROptionsVampire") == 0 || persistence() == 0) status_ = Status::NotLoaded;
}

void Game::detach() {
    if (serviceOpen_) dmntchtExit();
    serviceOpen_ = false;
    mainBase_ = 0;
    classNames_.clear();
    status_ = Status::NoGame;
}

const char* Game::statusText() const {
    switch (status_) {
        case Status::NoCheatService: return "Atmosphère cheat service not available";
        case Status::NoGame: return "Start Moonlight Peaks first";
        case Status::OtherGame: return "The running game is not Moonlight Peaks";
        case Status::WrongVersion: return "Unsupported game version (needs 1.1.30)";
        case Status::NotLoaded: return "Load your save first";
        case Status::Ready: return "Moonlight Peaks 1.1.30 detected";
    }
    return "";
}

/* ---------- memory primitives ---------- */

bool Game::read(u64 addr, void* out, size_t size) {
    if (mainBase_ == 0) return false;
    return R_SUCCEEDED(dmntchtReadCheatProcessMemory(addr, out, size));
}

bool Game::write(u64 addr, const void* in, size_t size) {
    if (mainBase_ == 0) return false;
    return R_SUCCEEDED(dmntchtWriteCheatProcessMemory(addr, in, size));
}

// Name of the object's class, or "" if the object doesn't look like a managed
// object. A real Il2CppClass points to itself at +0x78; verified classes are
// cached so each class is only checked once.
std::string Game::className(u64 object) {
    u64 klass = 0;
    if (!plausiblePointer(object) || !read(object, klass) || !plausiblePointer(klass)) return "";
    for (const auto& [k, n] : classNames_)
        if (k == klass) return n;
    u64 self = 0, namePtr = 0;
    if (!read(klass + kClassSelf, self) || self != klass || !read(klass + kClassName, namePtr) || namePtr < 0x1000000)
        return "";
    std::string name;
    char chunk[16];
    while (name.size() < 64) {
        if (!read(namePtr + name.size(), chunk, sizeof(chunk))) return "";
        const void* end = std::memchr(chunk, 0, sizeof(chunk));
        size_t len = end ? size_t(static_cast<const char*>(end) - chunk) : sizeof(chunk);
        name.append(chunk, len);
        if (len < sizeof(chunk)) break;
    }
    classNames_.emplace_back(klass, name);
    return name;
}

u64 Game::staticObject(u64 typeInfo, u64 staticFieldOffset, const char* name) {
    u64 klass = 0, statics = 0, object = 0;
    if (!read(mainBase_ + typeInfo, klass) || !plausiblePointer(klass)) return 0;
    if (!read(klass + kClassStaticFields, statics) || !plausiblePointer(statics)) return 0;
    if (!read(statics + staticFieldOffset, object) || !isInstance(object, name)) return 0;
    return object;
}

// Reference field of an object, checked to be an instance of the named class.
u64 Game::field(u64 object, u32 offset, const char* name) {
    u64 value = 0;
    if (!plausiblePointer(object) || !read(object + offset, value) || !isInstance(value, name)) return 0;
    return value;
}

// Elements of a System.Collections.Generic.List<T> of references.
bool Game::listItems(u64 list, std::vector<u64>& out) {
    u64 items = 0;
    s32 size = 0;
    out.clear();
    if (!plausiblePointer(list) || !read(list + off::kListItems, items) || !read(list + off::kListSize, size)) return false;
    if (size < 0 || size > 65536) return false;
    if (size == 0) return true;
    if (!plausiblePointer(items)) return false;
    out.resize(size);
    return read(items + off::kArrayData, out.data(), out.size() * sizeof(u64));
}

bool Game::guidListItems(u64 guidList, std::vector<u64>& out) {
    u64 list = 0;
    return plausiblePointer(guidList) && read(guidList + off::kGuidListList, list) && listItems(list, out);
}

/* ---------- game objects ---------- */

u64 Game::persistence() {
    return staticObject(type::kGamePersistence, 0, "GamePersistence");
}

u64 Game::playerInventory(const Guid& id) {
    u64 player = field(persistence(), off::kGamePlayer, "PlayerPersistence");
    u64 inventories = 0;
    std::vector<u64> list;
    if (!player || !read(player + off::kPlayerInventories, inventories) || !guidListItems(inventories, list)) return 0;
    for (u64 inventory : list) {
        Guid guid{};
        if (isInstance(inventory, "InventoryPersistence") && read(inventory + off::kGuid, guid) && guid == id) return inventory;
    }
    return 0;
}

// The wallet's single slot, checked to hold the coin item.
u64 Game::coinSlot() {
    u64 wallet = playerInventory(kWalletInventory);
    u64 slotsList = 0, ref = 0;
    std::vector<u64> slots;
    if (!wallet || !read(wallet + off::kInventorySlots, slotsList) || !listItems(slotsList, slots) || slots.size() != 1) return 0;
    Guid item{};
    if (!isInstance(slots[0], "InventorySlotPersistence") || !read(slots[0] + off::kSlotItemRef, ref) ||
        !plausiblePointer(ref) || !read(ref + off::kAssetRefGuid, item) || !(item == kCoinItem))
        return 0;
    return slots[0];
}

u64 Game::timePersistence() {
    return field(persistence(), off::kGameTime, "TimePersistence");
}

/* ---------- features ---------- */

bool Game::getDevFlag(u32 offset, bool& out) {
    u64 options = staticObject(type::kSROptionsVampire, 0, "SROptionsVampire");
    u8 value = 0;
    if (options == 0 || !read(options + offset, value)) return false;
    out = value != 0;
    return true;
}

bool Game::setDevFlag(u32 offset, bool value) {
    u64 options = staticObject(type::kSROptionsVampire, 0, "SROptionsVampire");
    u8 byte = value ? 1 : 0;
    return options != 0 && write(options + offset, byte);
}

bool Game::getCoins(s32& out) {
    u64 slot = coinSlot();
    return slot && read(slot + off::kSlotAmount, out);
}

bool Game::setCoins(s32 value) {
    if (value < 0 || value > kMaxCoins) return false;
    u64 slot = coinSlot();
    return slot && write(slot + off::kSlotAmount, value);
}

bool Game::getDayProgression(float& out) {
    u64 time = timePersistence();
    return time && read(time + off::kTimeDayProgression, out) && out >= 0.f && out <= 1.f;
}

bool Game::setDayProgression(float value) {
    if (!(value >= 0.f && value < 1.f)) return false;
    u64 time = timePersistence();
    return time && write(time + off::kTimeDayProgression, value);
}

int Game::finishMachines(s32 days) {
    u64 game = persistence();
    u64 rooms = 0;
    std::vector<u64> roomList;
    if (!game || !read(game + off::kGameRooms, rooms) || !guidListItems(rooms, roomList)) return -1;
    int changed = 0;
    std::vector<u64> converters, producing;
    for (u64 room : roomList) {
        u64 list = 0;
        if (!isInstance(room, "RoomPersistence") || !read(room + off::kRoomResourceConverters, list) ||
            !guidListItems(list, converters))
            continue;
        for (u64 converter : converters) {
            u64 items = 0;
            s32 previousDay = 0;
            if (!isInstance(converter, "ResourceConverterPersistence") ||
                !read(converter + off::kConverterProducingItems, items) || !listItems(items, producing) ||
                producing.empty() || !isInstance(producing[0], "ResourceConverterItemPersistence"))
                continue;
            if (!read(converter + off::kConverterPreviousDay, previousDay) || previousDay < 0 || previousDay > 100000) continue;
            if (write(converter + off::kConverterPreviousDay, s32(previousDay - days))) changed++;
        }
    }
    return changed;
}

int Game::setOneHit(bool on) {
    u64 tools = playerInventory(kToolsInventory);
    u64 slotsList = 0;
    std::vector<u64> slots;
    if (!tools || !read(tools + off::kInventorySlots, slotsList) || !listItems(slotsList, slots)) return -1;
    int done = 0;
    for (u64 slot : slots) {
        u64 ref = 0, asset = 0, addon = 0;
        Guid id{}, assetId{};
        if (!isInstance(slot, "InventorySlotPersistence") || !read(slot + off::kSlotItemRef, ref) || !plausiblePointer(ref) ||
            !read(ref + off::kAssetRefGuid, id))
            continue;
        const ToolDamage* tool = findTool(id);
        if (!tool) continue;
        if (!read(ref + off::kAssetRefRawAsset, asset) || !isInstance(asset, "ItemAsset") ||
            !read(asset + off::kAssetGuid, assetId) || !(assetId == id) || !read(asset + off::kItemToolAddon, addon) ||
            !plausiblePointer(addon))
            continue;
        s32 current = 0;
        if (!read(addon + off::kToolDamage, current) || (current != tool->damage && current != kOneHitDamage)) continue;
        s32 wanted = on ? kOneHitDamage : tool->damage;
        if (current == wanted || write(addon + off::kToolDamage, wanted)) done++;
    }
    return done;
}

bool Game::getOneHit(bool& on) {
    u64 tools = playerInventory(kToolsInventory);
    u64 slotsList = 0;
    std::vector<u64> slots;
    if (!tools || !read(tools + off::kInventorySlots, slotsList) || !listItems(slotsList, slots)) return false;
    bool found = false;
    on = false;
    for (u64 slot : slots) {
        u64 ref = 0, asset = 0, addon = 0;
        Guid id{};
        s32 damage = 0;
        if (!plausiblePointer(slot) || !read(slot + off::kSlotItemRef, ref) || !plausiblePointer(ref) ||
            !read(ref + off::kAssetRefGuid, id) || !findTool(id))
            continue;
        if (!read(ref + off::kAssetRefRawAsset, asset) || !isInstance(asset, "ItemAsset") ||
            !read(asset + off::kItemToolAddon, addon) || !plausiblePointer(addon) || !read(addon + off::kToolDamage, damage))
            continue;
        found = true;
        if (damage == kOneHitDamage) on = true;
    }
    return found;
}

int Game::refillAnimalProduce() {
    u64 game = persistence();
    u64 creatures = 0;
    std::vector<u64> list;
    if (!game || !read(game + off::kGameHousedCreatures, creatures) || !guidListItems(creatures, list)) return -1;
    int changed = 0;
    for (u64 creature : list) {
        u64 table = field(creature, off::kCreatureProduce, "SerializableDictionary`2");
        u64 dict = field(table, off::kSerializableDictDict, "Dictionary`2");
        u64 entries = 0;
        s32 count = 0;
        if (!isInstance(creature, "CreaturePersistence") || !dict || !read(dict + off::kDictEntries, entries) ||
            !plausiblePointer(entries) || !read(dict + off::kDictCount, count) || count < 0 || count > 64)
            continue;
        for (s32 i = 0; i < count; i++) {
            u64 entry = entries + off::kArrayData + u64(i) * off::kProduceEntrySize;
            s32 next = 0;
            float value = 0.f;
            if (!read(entry + off::kProduceEntryNext, next) || next < -1 || !read(entry + off::kProduceEntryValue, value) ||
                !(value >= 0.f && value < 1.f))
                continue;
            const float full = 1.f;
            if (write(entry + off::kProduceEntryValue, full)) changed++;
        }
    }
    return changed;
}

/* ---------- time speed and constructions ---------- */

// A MonoBehaviourSingleton found by class name in the shared instances table.
u64 Game::singleton(const char* name) {
    u64 table = staticObject(type::kMonoBehaviourSingleton, 0, "Dictionary`2");
    u64 entries = 0;
    s32 count = 0;
    if (!table || !read(table + off::kDictEntries, entries) || !plausiblePointer(entries) ||
        !read(table + off::kDictCount, count) || count < 0 || count > 1024)
        return 0;
    std::vector<u8> raw(size_t(count) * off::kObjectDictEntrySize);
    if (count == 0 || !read(entries + off::kArrayData, raw.data(), raw.size())) return 0;
    for (s32 i = 0; i < count; i++) {
        u64 value = 0;
        s32 next = 0;
        std::memcpy(&next, &raw[size_t(i) * off::kObjectDictEntrySize + 4], sizeof(next));
        std::memcpy(&value, &raw[size_t(i) * off::kObjectDictEntrySize + off::kObjectDictEntryValue], sizeof(value));
        if (next >= -1 && value && isInstance(value, name)) return value;
    }
    return 0;
}

bool Game::getTimeSpeed(float& out) {
    u64 progresser = singleton("DayProgresser");
    return progresser && read(progresser + off::kDayProgresserSpeed, out) && out >= 0.f && out <= 16.f;
}

bool Game::setTimeSpeed(float value) {
    if (!(value >= 0.f && value <= 4.f)) return false;
    u64 progresser = singleton("DayProgresser");
    float current = 0.f;
    return progresser && read(progresser + off::kDayProgresserSpeed, current) && current >= 0.f && current <= 16.f &&
           write(progresser + off::kDayProgresserSpeed, value);
}

int Game::finishConstructionsTonight() {
    u64 game = persistence(), list = 0;
    std::vector<u64> constructions;
    if (!game || !read(game + off::kGameConstructions, list) || !guidListItems(list, constructions)) return -1;
    int tonight = 0;
    for (u64 construction : constructions) {
        s32 daysLeft = 0;
        if (!isInstance(construction, "GridObjectConstructionPersistence") ||
            !read(construction + off::kConstructionDaysLeft, daysLeft) || daysLeft < 1 || daysLeft > 1000)
            continue;
        const s32 oneDay = 1;
        if (daysLeft == 1 || write(construction + off::kConstructionDaysLeft, oneDay)) tonight++;
    }
    return tonight;
}

/* ---------- inventories ---------- */

namespace {
// InventorySlotPersistence.ItemEntry, read in one go from slot + 0x10.
struct RawItemEntry {
    s32 quality;
    s32 amount;
    u64 metadata;
    u64 customName;
    u64 itemRef;
};
static_assert(sizeof(RawItemEntry) == 0x20);
}  // namespace

bool Game::itemOfRef(u64 assetRef, Guid& out) {
    return isInstance(assetRef, "AssetRef`1") && read(assetRef + off::kAssetRefGuid, out);
}

bool Game::readSlot(u64 address, Slot& out) {
    RawItemEntry entry{};
    out = Slot{};
    out.address = address;
    if (!isInstance(address, "InventorySlotPersistence") || !read(address + off::kSlotQuality, entry)) return false;
    out.amount = entry.amount;
    if (entry.itemRef == 0) return true;
    if (!itemOfRef(entry.itemRef, out.item)) return false;
    out.empty = false;
    return true;
}

bool Game::readInventory(const Guid& inventory, std::vector<Slot>& out) {
    out.clear();
    u64 inv = playerInventory(inventory), slotsList = 0;
    std::vector<u64> slots;
    if (!inv || !read(inv + off::kInventorySlots, slotsList) || !listItems(slotsList, slots)) return false;
    for (u64 address : slots) {
        Slot slot;
        if (!readSlot(address, slot)) return false;
        out.push_back(slot);
    }
    return true;
}

bool Game::setSlotAmount(const Slot& slot, s32 amount) {
    Slot now;
    if (slot.empty || amount < 1 || !readSlot(slot.address, now) || now.empty || !(now.item == slot.item)) return false;
    return write(slot.address + off::kSlotAmount, amount);
}

bool Game::collectItemRefs(std::vector<ItemRef>& out) {
    out.clear();
    u64 game = persistence();
    if (!game) return false;
    std::vector<u64> inventories, part;
    u64 list = 0;
    u64 player = field(game, off::kGamePlayer, "PlayerPersistence");
    if (player && read(player + off::kPlayerInventories, list) && guidListItems(list, part))
        inventories.insert(inventories.end(), part.begin(), part.end());
    std::vector<u64> rooms;
    if (read(game + off::kGameRooms, list) && guidListItems(list, rooms)) {
        for (u64 room : rooms) {
            if (isInstance(room, "RoomPersistence") && read(room + off::kRoomInventories, list) && guidListItems(list, part))
                inventories.insert(inventories.end(), part.begin(), part.end());
        }
    }
    std::vector<u64> slots;
    for (u64 inventory : inventories) {
        u64 slotsList = 0;
        if (!isInstance(inventory, "InventoryPersistence") || !read(inventory + off::kInventorySlots, slotsList) ||
            !listItems(slotsList, slots))
            continue;
        for (u64 address : slots) {
            u64 ref = 0;
            Guid item{};
            if (!read(address + off::kSlotItemRef, ref) || ref == 0 || !itemOfRef(ref, item) || item == kCoinItem) continue;
            bool known = false;
            for (const auto& r : out) known = known || r.item == item;
            if (!known) out.push_back({item, ref});
        }
    }
    return true;
}

int Game::giveItem(const Guid& inventory, const ItemRef& ref, s32 amount) {
    Guid item{};
    if (amount < 1 || !itemOfRef(ref.assetRef, item) || !(item == ref.item)) return -1;
    u64 inv = playerInventory(inventory), slotsList = 0;
    std::vector<u64> slots;
    if (!inv || !read(inv + off::kInventorySlots, slotsList) || !listItems(slotsList, slots)) return -1;
    for (size_t i = 0; i < slots.size(); i++) {
        RawItemEntry entry{};
        if (!isInstance(slots[i], "InventorySlotPersistence") || !read(slots[i] + off::kSlotQuality, entry)) return -1;
        if (entry.itemRef || entry.metadata || entry.customName || entry.amount != 0) continue;
        // Amount and quality first; the item reference last makes the slot non-empty.
        const s32 normalQuality = 0;
        if (!write(slots[i] + off::kSlotQuality, normalQuality) || !write(slots[i] + off::kSlotAmount, amount) ||
            !write(slots[i] + off::kSlotItemRef, ref.assetRef))
            return -1;
        return int(i);
    }
    return -2;
}

std::vector<std::string> Game::diagnose() {
    std::vector<std::string> out;
    auto yes = [](bool ok) { return ok ? "ok" : "FAILED"; };
    out.push_back(format("main base %#lx", mainBase_));
    u64 options = staticObject(type::kSROptionsVampire, 0, "SROptionsVampire");
    out.push_back(format("Developer options: %s", yes(options)));
    u64 game = persistence();
    out.push_back(format("GamePersistence: %s", yes(game)));
    if (!game) return out;

    u64 playerRaw = 0;
    read(game + off::kGamePlayer, playerRaw);
    u64 player = field(game, off::kGamePlayer, "PlayerPersistence");
    out.push_back(format("Player: %s (class '%s')", yes(player), className(playerRaw).c_str()));
    u64 inventories = 0;
    std::vector<u64> invList;
    bool invOk = player && read(player + off::kPlayerInventories, inventories) && guidListItems(inventories, invList);
    out.push_back(format("Inventories: %s, %zu found, first class '%s'", yes(invOk), invList.size(),
                         invList.empty() ? "-" : className(invList[0]).c_str()));
    u64 wallet = playerInventory(kWalletInventory);
    u64 slot = coinSlot();
    s32 coins = -1;
    if (slot) read(slot + off::kSlotAmount, coins);
    out.push_back(format("Wallet: %s, coin slot: %s, coins %d", yes(wallet), yes(slot), coins));

    u64 tools = playerInventory(kToolsInventory);
    u64 slotsList = 0;
    std::vector<u64> slots;
    int known = 0, resolved = 0;
    if (tools && read(tools + off::kInventorySlots, slotsList) && listItems(slotsList, slots)) {
        for (u64 s : slots) {
            u64 ref = 0, asset = 0;
            Guid id{};
            if (!read(s + off::kSlotItemRef, ref) || !plausiblePointer(ref) || !read(ref + off::kAssetRefGuid, id) || !findTool(id))
                continue;
            known++;
            if (read(ref + off::kAssetRefRawAsset, asset) && isInstance(asset, "ItemAsset")) resolved++;
        }
    }
    out.push_back(format("Tool belt: %s, %zu slots, axes/pickaxes %d, loaded %d", yes(tools), slots.size(), known, resolved));

    u64 rooms = 0;
    std::vector<u64> roomList, converters, producing;
    int roomOk = 0, convTotal = 0, busy = 0;
    if (read(game + off::kGameRooms, rooms) && guidListItems(rooms, roomList)) {
        for (u64 room : roomList) {
            u64 list = 0;
            if (!isInstance(room, "RoomPersistence")) continue;
            roomOk++;
            if (!read(room + off::kRoomResourceConverters, list) || !guidListItems(list, converters)) continue;
            for (u64 c : converters) {
                convTotal++;
                u64 items = 0;
                if (read(c + off::kConverterProducingItems, items) && listItems(items, producing) && !producing.empty()) busy++;
            }
        }
    }
    out.push_back(format("Rooms: %zu (%d ok), machines %d, busy %d", roomList.size(), roomOk, convTotal, busy));

    u64 creatures = 0;
    std::vector<u64> creatureList;
    int produce = 0;
    if (read(game + off::kGameHousedCreatures, creatures) && guidListItems(creatures, creatureList)) {
        for (u64 c : creatureList) {
            u64 dict = field(field(c, off::kCreatureProduce, "SerializableDictionary`2"), off::kSerializableDictDict, "Dictionary`2");
            s32 count = 0;
            if (dict && read(dict + off::kDictCount, count)) produce += count;
        }
    }
    out.push_back(format("Animals: %zu, produce values %d", creatureList.size(), produce));

    std::vector<Slot> slotsRead;
    for (const auto& [name, id] : {std::pair{"Backpack", kBackpackInventory}, std::pair{"Storage", kStorageInventory}}) {
        bool ok = readInventory(id, slotsRead);
        int filled = 0;
        for (const auto& s : slotsRead) filled += !s.empty;
        out.push_back(format("%s: %s, %zu slots, %d filled", name, yes(ok), slotsRead.size(), filled));
    }
    std::vector<ItemRef> refs;
    out.push_back(format("Givable items: %s, %zu", yes(collectItemRefs(refs)), refs.size()));

    float speed = -1.f;
    u64 progresser = singleton("DayProgresser");
    if (progresser) read(progresser + off::kDayProgresserSpeed, speed);
    out.push_back(format("DayProgresser: %s, time speed %.2f", yes(progresser), double(speed)));
    u64 list = 0;
    std::vector<u64> constructions;
    std::string days;
    if (read(game + off::kGameConstructions, list) && guidListItems(list, constructions)) {
        for (u64 c : constructions) {
            s32 d = 0;
            if (isInstance(c, "GridObjectConstructionPersistence") && read(c + off::kConstructionDaysLeft, d)) days += std::to_string(d) + " ";
        }
    }
    out.push_back(format("Constructions: %zu, days left: %s", constructions.size(), days.c_str()));
    return out;
}

}  // namespace mp
