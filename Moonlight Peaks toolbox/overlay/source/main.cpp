// Moonlight Peaks Toolbox: Ultrahand/Tesla overlay for Moonlight Peaks 1.1.30.
#define TESLA_INIT_IMPL
#include <exception_wrap.hpp>
#include <tesla.hpp>

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <functional>
#include <string>
#include <vector>

#include "game.hpp"
#include "items.hpp"

namespace {

mp::Game g_game;

std::string withThousands(s32 value) {
    std::string digits = std::to_string(value), out;
    for (size_t i = 0; i < digits.size(); i++) {
        if (i && (digits.size() - i) % 3 == 0) out += ',';
        out += digits[i];
    }
    return out;
}

std::string clockText(float progression) {
    float hours = progression * mp::kDayCycleHours;
    int hour = (mp::kDayStartHour + int(std::floor(hours))) % 24;
    int minute = int((hours - std::floor(hours)) * 60.f);
    char buf[8];
    std::snprintf(buf, sizeof(buf), "%02d:%02d", hour, minute);
    return buf;
}

bool pressedA(u64 keys) {
    return keys & HidNpadButton_A;
}

// Hours later tonight. Only forward jumps are offered: going back in time
// could replay time-based events.
class HourGui : public tsl::Gui {
public:
    tsl::elm::Element* createUI() override {
        auto* frame = new tsl::elm::OverlayFrame("Moonlight Peaks", "Jump forward in time");
        auto* list = new tsl::elm::List();
        float now = 0.f;
        if (!g_game.getDayProgression(now)) {
            list->addItem(new tsl::elm::ListItem("Time not available (load your save)"));
        } else {
            list->addItem(new tsl::elm::CategoryHeader("Now " + clockText(now) + " · pick a later hour"));
            int added = 0;
            for (int step = 1; step < mp::kDayCycleHours; step++) {
                int hour = (mp::kDayStartHour + step) % 24;
                float target = mp::progressionForHour(hour);
                if (target <= now + 1.f / 720.f) continue;
                auto* item = new tsl::elm::ListItem(clockText(target));
                item->setClickListener([target](u64 keys) {
                    if (!pressedA(keys)) return false;
                    g_game.setDayProgression(target);
                    tsl::goBack();
                    return true;
                });
                list->addItem(item);
                added++;
            }
            if (!added) list->addItem(new tsl::elm::ListItem("No later hour tonight"));
        }
        frame->setContent(list);
        return frame;
    }
};

std::string itemName(const mp::Guid& id) {
    const mp::ItemInfo* info = mp::findItem(id);
    return info ? info->name : "Unknown item";
}

s32 maxStackOf(const mp::Guid& id) {
    const mp::ItemInfo* info = mp::findItem(id);
    return info ? info->maxStack : 1;
}

// Amount editor for one filled slot.
class SlotGui : public tsl::Gui {
public:
    explicit SlotGui(mp::Slot slot) : slot_(slot), max_(std::min<s32>(maxStackOf(slot.item), mp::kMaxCoins)) {}

    tsl::elm::Element* createUI() override {
        auto* frame = new tsl::elm::OverlayFrame("Moonlight Peaks", itemName(slot_.item));
        auto* list = new tsl::elm::List();
        amount_ = new tsl::elm::ListItem("Amount", "×" + withThousands(slot_.amount));
        list->addItem(amount_);
        if (max_ <= 1) {
            list->addItem(new tsl::elm::ListItem("This item does not stack"));
        } else {
            list->addItem(new tsl::elm::CategoryHeader("Change (max " + withThousands(max_) + ")"));
            addButton(list, "Set to max", [this] { return max_; });
            addButton(list, "+10", [this] { return slot_.amount + 10; });
            addButton(list, "+1", [this] { return slot_.amount + 1; });
            addButton(list, "-1", [this] { return slot_.amount - 1; });
            addButton(list, "-10", [this] { return slot_.amount - 10; });
            addButton(list, "Set to 1", [] { return 1; });
        }
        frame->setContent(list);
        return frame;
    }

private:
    void addButton(tsl::elm::List* list, const char* label, std::function<s32()> target) {
        auto* item = new tsl::elm::ListItem(label);
        item->setClickListener([this, target](u64 keys) {
            if (!pressedA(keys)) return false;
            s32 wanted = std::clamp<s32>(target(), 1, max_);
            if (g_game.setSlotAmount(slot_, wanted)) {
                slot_.amount = wanted;
                amount_->setValue("×" + withThousands(wanted));
            } else {
                amount_->setValue("could not change");
            }
            return true;
        });
        list->addItem(item);
    }

    mp::Slot slot_;
    s32 max_;
    tsl::elm::ListItem* amount_ = nullptr;
};

// Backpack or storage: one line per slot, refreshed about once a second.
class InventoryGui : public tsl::Gui {
public:
    InventoryGui(const char* title, mp::Guid inventory) : title_(title), inventory_(inventory) {}

    tsl::elm::Element* createUI() override {
        auto* frame = new tsl::elm::OverlayFrame("Moonlight Peaks", title_);
        auto* list = new tsl::elm::List();
        if (!g_game.readInventory(inventory_, slots_)) {
            list->addItem(new tsl::elm::ListItem("Not available (load your save)"));
        } else {
            summary_ = new tsl::elm::CategoryHeader("");
            list->addItem(summary_);
            for (size_t i = 0; i < slots_.size(); i++) {
                auto* item = new tsl::elm::ListItem("");
                item->setClickListener([this, i](u64 keys) {
                    if (!pressedA(keys) || i >= slots_.size() || slots_[i].empty) return false;
                    tsl::changeTo<SlotGui>(slots_[i]);
                    return true;
                });
                items_.push_back(item);
                list->addItem(item);
            }
            refresh();
        }
        frame->setContent(list);
        return frame;
    }

    void update() override {
        if (++frames_ % 30 == 0 && !items_.empty()) {
            std::vector<mp::Slot> fresh;
            if (g_game.readInventory(inventory_, fresh) && fresh.size() == items_.size()) {
                slots_ = fresh;
                refresh();
            }
        }
    }

private:
    void refresh() {
        int free = 0;
        for (size_t i = 0; i < slots_.size(); i++) {
            const auto& slot = slots_[i];
            free += slot.empty;
            items_[i]->setText(slot.empty ? "(empty)" : itemName(slot.item));
            items_[i]->setValue(slot.empty ? "" : "×" + withThousands(slot.amount));
        }
        if (summary_) summary_->setText(std::to_string(slots_.size() - free) + " stacks · " + std::to_string(free) + " free · A to edit");
    }

    const char* title_;
    mp::Guid inventory_;
    std::vector<mp::Slot> slots_;
    std::vector<tsl::elm::ListItem*> items_;
    tsl::elm::CategoryHeader* summary_ = nullptr;
    u32 frames_ = 0;
};

// Amount and destination for one item to give.
class GiveAmountGui : public tsl::Gui {
public:
    explicit GiveAmountGui(mp::ItemRef ref) : ref_(ref), max_(std::min<s32>(maxStackOf(ref.item), 100000)) {}

    tsl::elm::Element* createUI() override {
        auto* frame = new tsl::elm::OverlayFrame("Moonlight Peaks", "Give " + itemName(ref_.item));
        auto* list = new tsl::elm::List();
        for (const auto& [label, id] : {std::pair{"To backpack", mp::kBackpackInventory}, std::pair{"To storage", mp::kStorageInventory}}) {
            list->addItem(new tsl::elm::CategoryHeader(label));
            std::vector<s32> amounts{1};
            if (max_ >= 10) amounts.push_back(10);
            if (max_ > 10) amounts.push_back(max_);
            for (s32 amount : amounts) {
                std::string text = "Add " + withThousands(amount) + (amount == max_ && max_ > 1 ? " (full stack)" : "");
                auto* item = new tsl::elm::ListItem(text);
                mp::Guid target = id;
                item->setClickListener([this, item, target, amount](u64 keys) {
                    if (!pressedA(keys)) return false;
                    int slot = g_game.giveItem(target, ref_, amount);
                    item->setValue(slot >= 0 ? "added to slot " + std::to_string(slot + 1) : slot == -2 ? "no free slot" : "error");
                    return true;
                });
                list->addItem(item);
            }
        }
        list->addItem(new tsl::elm::ListItem("Uses a free slot; open the inventory to see it"));
        frame->setContent(list);
        return frame;
    }

private:
    mp::ItemRef ref_;
    s32 max_;
};

// Items that can be given: everything the game has loaded in your
// inventories, chests and known-recipe list, grouped by category.
class GiveGui : public tsl::Gui {
public:
    tsl::elm::Element* createUI() override {
        auto* frame = new tsl::elm::OverlayFrame("Moonlight Peaks", "Give items");
        auto* list = new tsl::elm::List();
        std::vector<mp::ItemRef> all;
        if (!g_game.collectItemRefs(all)) {
            list->addItem(new tsl::elm::ListItem("Not available (load your save)"));
        } else {
            for (const auto& ref : all) {
                const mp::ItemInfo* info = mp::findItem(ref.item);
                if (info && !info->hidden && givable(*info)) refs_.push_back({ref, info});
            }
            std::sort(refs_.begin(), refs_.end(), [](const Entry& a, const Entry& b) {
                int c = std::strcmp(mp::itemCategory(*a.info), mp::itemCategory(*b.info));
                return c != 0 ? c < 0 : std::strcmp(a.info->name, b.info->name) < 0;
            });
            list->addItem(new tsl::elm::ListItem(std::to_string(refs_.size()) + " items available"));
            const char* category = nullptr;
            for (size_t i = 0; i < refs_.size(); i++) {
                const char* c = mp::itemCategory(*refs_[i].info);
                if (!category || std::strcmp(category, c) != 0) {
                    category = c;
                    list->addItem(new tsl::elm::CategoryHeader(category));
                }
                auto* item = new tsl::elm::ListItem(refs_[i].info->name);
                item->setClickListener([this, i](u64 keys) {
                    if (!pressedA(keys)) return false;
                    tsl::changeTo<GiveAmountGui>(refs_[i].ref);
                    return true;
                });
                list->addItem(item);
            }
        }
        frame->setContent(list);
        return frame;
    }

private:
    // Only everyday items. Cards, collectibles, customizations, forms,
    // spells, tools, upgrades and books are left out: they belong to
    // collections or unlock content (progression).
    static bool givable(const mp::ItemInfo& info) {
        static const char* const kAllowed[] = {"Resource", "Seeds", "Consumable", "Decoration", "FarmHelper",
                                               "Fertilizer", "Fish", "Wild", "Growable"};
        for (const char* c : kAllowed)
            if (std::strcmp(mp::itemCategory(info), c) == 0) return true;
        return false;
    }

    struct Entry {
        mp::ItemRef ref;
        const mp::ItemInfo* info;
    };
    std::vector<Entry> refs_;
};

// Step-by-step state of every memory path, to see what fails on a console.
class DiagnosticsGui : public tsl::Gui {
public:
    tsl::elm::Element* createUI() override {
        auto* frame = new tsl::elm::OverlayFrame("Moonlight Peaks", "Diagnostics");
        auto* list = new tsl::elm::List();
        list->addItem(new tsl::elm::CategoryHeader(g_game.statusText()));
        for (const auto& line : g_game.diagnose()) list->addItem(new tsl::elm::ListItem(line));
        frame->setContent(list);
        return frame;
    }
};

struct DevToggle {
    const char* label;
    u32 offset;
    tsl::elm::ToggleListItem* item = nullptr;
};

class MainGui : public tsl::Gui {
public:
    tsl::elm::Element* createUI() override {
        auto* frame = new tsl::elm::OverlayFrame("Moonlight Peaks", "Toolbox " APP_VERSION);
        auto* list = new tsl::elm::List();

        g_game.attach();
        status_ = new tsl::elm::ListItem(g_game.statusText());
        list->addItem(status_);

        list->addItem(new tsl::elm::CategoryHeader("Player"));
        for (auto& toggle : player_) addToggle(list, toggle);

        list->addItem(new tsl::elm::CategoryHeader("Inventory"));
        addPage(list, "Backpack", [] { tsl::changeTo<InventoryGui>("Backpack", mp::kBackpackInventory); });
        addPage(list, "Storage", [] { tsl::changeTo<InventoryGui>("Storage", mp::kStorageInventory); });
        addPage(list, "Give items", [] { tsl::changeTo<GiveGui>(); });

        list->addItem(new tsl::elm::CategoryHeader("Coins"));
        coins_ = new tsl::elm::ListItem("Coins", "-");
        list->addItem(coins_);
        for (s32 amount : {1000, 10000, 100000}) {
            auto* item = new tsl::elm::ListItem("Add " + withThousands(amount));
            item->setClickListener([this, amount](u64 keys) {
                if (!pressedA(keys)) return false;
                s32 current = 0;
                if (g_game.getCoins(current)) g_game.setCoins(std::min<s32>(mp::kMaxCoins, current + amount));
                refreshValues();
                return true;
            });
            list->addItem(item);
        }

        list->addItem(new tsl::elm::CategoryHeader("Time"));
        clock_ = new tsl::elm::ListItem("Current time", "-");
        list->addItem(clock_);
        auto* jump = new tsl::elm::ListItem("Jump forward to…", ">");
        jump->setClickListener([](u64 keys) {
            if (!pressedA(keys)) return false;
            tsl::changeTo<HourGui>();
            return true;
        });
        list->addItem(jump);
        pause_ = new tsl::elm::ToggleListItem("Pause time", false);
        pause_->setStateChangedListener([this](bool state) {
            float current = 1.f;
            g_game.getTimeSpeed(current);
            if (state && current > 0.f) lastSpeed_ = current;
            if (!g_game.setTimeSpeed(state ? 0.f : (lastSpeed_ > 0.f ? lastSpeed_ : 1.f))) pause_->setState(!state);
            refreshValues();
        });
        list->addItem(pause_);
        speed_ = new tsl::elm::ListItem("Time speed", "-");
        speed_->setClickListener([this](u64 keys) {
            if (!pressedA(keys)) return false;
            float current = 1.f;
            if (g_game.getTimeSpeed(current)) {
                // x1/2 -> x1 -> x2 -> x1/2; from paused, resume at normal speed.
                float next = current <= 0.f ? 1.f : current < 0.75f ? 1.f : current < 1.5f ? 2.f : 0.5f;
                if (g_game.setTimeSpeed(next)) lastSpeed_ = next;
            }
            refreshValues();
            return true;
        });
        list->addItem(speed_);

        list->addItem(new tsl::elm::CategoryHeader("Buildings"));
        constructions_ = new tsl::elm::ListItem("Finish constructions tonight");
        constructions_->setClickListener([this](u64 keys) {
            if (!pressedA(keys)) return false;
            int count = g_game.finishConstructionsTonight();
            constructions_->setValue(count < 0 ? "error" : count == 0 ? "none in progress" : std::to_string(count) + " finish tonight");
            return true;
        });
        list->addItem(constructions_);
        list->addItem(new tsl::elm::ListItem("Sleep: they finish overnight"));

        list->addItem(new tsl::elm::CategoryHeader("Farm & gathering"));
        bool oneHit = false;
        g_game.getOneHit(oneHit);
        oneHit_ = new tsl::elm::ToggleListItem("One-hit trees & rocks", oneHit);
        oneHit_->setStateChangedListener([this](bool state) {
            if (g_game.setOneHit(state) <= 0) oneHit_->setState(!state);
        });
        list->addItem(oneHit_);
        for (auto& toggle : farm_) addToggle(list, toggle);
        produce_ = new tsl::elm::ListItem("Refill animal produce");
        produce_->setClickListener([this](u64 keys) {
            if (!pressedA(keys)) return false;
            int count = g_game.refillAnimalProduce();
            produce_->setValue(count < 0 ? "error" : std::to_string(count) + " refilled");
            return true;
        });
        list->addItem(produce_);
        machines_ = new tsl::elm::ListItem("Finish all machines");
        machines_->setClickListener([this](u64 keys) {
            if (!pressedA(keys)) return false;
            int count = g_game.finishMachines(7);
            machines_->setValue(count < 0 ? "error" : std::to_string(count) + " updated");
            return true;
        });
        list->addItem(machines_);

        list->addItem(new tsl::elm::CategoryHeader("Help"));
        auto* diagnostics = new tsl::elm::ListItem("Diagnostics", ">");
        diagnostics->setClickListener([](u64 keys) {
            if (!pressedA(keys)) return false;
            tsl::changeTo<DiagnosticsGui>();
            return true;
        });
        list->addItem(diagnostics);
        list->addItem(new tsl::elm::ListItem("Changes reset when the game restarts"));
        frame->setContent(list);
        refreshValues();
        return frame;
    }

    // About once a second: re-attach if needed and show the game's real values.
    void update() override {
        if (++frames_ % 60 != 0) return;
        if (g_game.status() != mp::Status::Ready) g_game.attach();
        refreshValues();
    }

private:
    static void addPage(tsl::elm::List* list, const char* label, std::function<void()> open) {
        auto* item = new tsl::elm::ListItem(label, ">");
        item->setClickListener([open](u64 keys) {
            if (!pressedA(keys)) return false;
            open();
            return true;
        });
        list->addItem(item);
    }

    void addToggle(tsl::elm::List* list, DevToggle& toggle) {
        bool on = false;
        g_game.getDevFlag(toggle.offset, on);
        toggle.item = new tsl::elm::ToggleListItem(toggle.label, on);
        toggle.item->setStateChangedListener([&toggle](bool state) {
            if (!g_game.setDevFlag(toggle.offset, state)) toggle.item->setState(!state);
        });
        list->addItem(toggle.item);
    }

    static void sync(tsl::elm::ToggleListItem* item, bool on) {
        if (item && item->getState() != on) item->setState(on);
    }

    void syncToggles(DevToggle* begin, DevToggle* end) {
        for (DevToggle* t = begin; t != end; ++t) {
            bool on = false;
            if (g_game.getDevFlag(t->offset, on)) sync(t->item, on);
        }
    }

    void refreshValues() {
        if (status_) status_->setText(g_game.statusText());
        syncToggles(player_.begin(), player_.end());
        syncToggles(farm_.begin(), farm_.end());
        bool oneHit = false;
        if (g_game.getOneHit(oneHit)) sync(oneHit_, oneHit);
        s32 coins = 0;
        if (coins_) coins_->setValue(g_game.getCoins(coins) ? withThousands(coins) : "-");
        float progression = 0.f;
        if (clock_) clock_->setValue(g_game.getDayProgression(progression) ? clockText(progression) : "-");
        float speed = 0.f;
        if (g_game.getTimeSpeed(speed)) {
            sync(pause_, speed <= 0.f);
            char buf[16];
            std::snprintf(buf, sizeof(buf), "x%g", double(speed));
            if (speed_) speed_->setValue(speed <= 0.f ? "paused" : speed == 0.5f ? "x1/2" : buf);
        } else if (speed_) {
            speed_->setValue("-");
        }
    }

    std::array<DevToggle, 2> player_{{
        {"Infinite energy", mp::sro::kDisableEnergyUse},
        {"Infinite mana", mp::sro::kDisableManaUse},
    }};
    std::array<DevToggle, 3> farm_{{
        {"Any tool breaks anything", mp::sro::kIgnoreToolTiers},
        {"Animals always drop produce", mp::sro::kAlwaysSpawnProduce},
        {"Repeatable daily item drops", mp::sro::kDailyRandomItemDropCheat},
    }};
    tsl::elm::ListItem* status_ = nullptr;
    tsl::elm::ListItem* coins_ = nullptr;
    tsl::elm::ListItem* clock_ = nullptr;
    tsl::elm::ListItem* machines_ = nullptr;
    tsl::elm::ListItem* produce_ = nullptr;
    tsl::elm::ListItem* speed_ = nullptr;
    tsl::elm::ListItem* constructions_ = nullptr;
    tsl::elm::ToggleListItem* pause_ = nullptr;
    float lastSpeed_ = 1.f;
    tsl::elm::ToggleListItem* oneHit_ = nullptr;
    u32 frames_ = 0;
};

class ToolboxOverlay : public tsl::Overlay {
public:
    void initServices() override { pmdmntInitialize(); }
    void exitServices() override {
        g_game.detach();
        pmdmntExit();
    }
    std::unique_ptr<tsl::Gui> loadInitialGui() override { return initially<MainGui>(); }
};

}  // namespace

int main(int argc, char** argv) {
    return tsl::loop<ToolboxOverlay>(argc, argv);
}
