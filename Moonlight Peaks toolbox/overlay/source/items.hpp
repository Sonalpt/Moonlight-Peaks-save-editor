// Item names and stack sizes (generated from the save editor's database).
#pragma once

#include "game.hpp"

namespace mp {

struct ItemInfo {
    u64 part1;
    u64 part2;
    s32 maxStack;
    u8 hidden;    // developer/test/deprecated item
    u8 category;  // index into the category names
    const char* name;
};

const ItemInfo* findItem(const Guid& id);
const char* itemCategory(const ItemInfo& item);

}  // namespace mp
