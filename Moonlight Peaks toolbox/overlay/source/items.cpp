#include "items.hpp"

#include <algorithm>

namespace mp {

#include "items_db.inc"

const ItemInfo* findItem(const Guid& id) {
    auto less = [](const ItemInfo& item, const Guid& g) {
        return item.part1 != g.part1 ? item.part1 < g.part1 : item.part2 < g.part2;
    };
    const ItemInfo* end = kItems + sizeof(kItems) / sizeof(kItems[0]);
    const ItemInfo* it = std::lower_bound(kItems, end, id, less);
    return (it != end && it->part1 == id.part1 && it->part2 == id.part2) ? it : nullptr;
}

const char* itemCategory(const ItemInfo& item) {
    return kItemCategories[item.category];
}

}  // namespace mp
