const ShopRoles = {
  SHOP_OWNER: "SHOP_OWNER",
  WRITER: "WRITER",
  ADMIN: "ADMIN",
};

const DISCOUNT_TYPES = {
  FIXED_AMOUNT: "fixed_amount",
  PERCENTAGE: "percentage",
};

const DISCOUNT_APPLIES_TO = {
  ALL_PRODUCTS: "all",
  SPECIFIC_PRODUCTS: "specific",
  CATEGORY: "category",
};

module.exports = {
  ShopRoles,
  DISCOUNT_APPLIES_TO,
  DISCOUNT_TYPES,
};
